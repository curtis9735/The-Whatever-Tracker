import { rawDb } from '../db';
import { logEpisodesSql } from './items';
import { logEpisodeLabel, parseLogEpisodes } from '$lib/episodes';
import { imageSrc, type ImageRef } from '$lib/images';
import { addDays, heatmap, journalStats, type DateRange } from '$lib/journal';
import type { SetlistEvent } from '$lib/types';

/** The person has imported last.fm listening logs (with or without an account still connected) */
export function hasListeningLogs(userId: number): boolean {
	return !!rawDb()
		.prepare("SELECT 1 FROM item_logs WHERE user_id = ? AND source = 'lastfm' LIMIT 1")
		.get(userId);
}

/** How imported last.fm listening shows: one row per day, not at all, or every album */
export type ListeningMode = 'group' | 'hide' | 'all';

export const isListeningMode = (v: unknown): v is ListeningMode =>
	v === 'group' || v === 'hide' || v === 'all';

export type JournalEntry = JournalLog | JournalListening;

/** A whole listening day, as one row (grouped mode) */
export interface JournalListening {
	kind: 'listening';
	id: string;
	date: string;
	/** Albums played that day, and the tracks (plays) in all */
	albums: number;
	tracks: number;
	/** Covers of the most played albums, up to 4 */
	covers: string[];
}

export interface JournalLog {
	kind: 'log';
	id: number;
	date: string;
	rating: number | null;
	location: string | null;
	notes: string | null;
	setlistSongs: number | null;
	/** Tracks played, for a day of imported last.fm listening */
	plays: number | null;
	/** "S2 E5 · Title" for an episode check-in */
	episode: string | null;
	itemId: number;
	title: string;
	subtitle: string | null;
	categoryName: string;
	categoryIcon: string;
	categoryColor: string;
	imageUrl: string | null;
}

/*
 * The journal reads the viewer's own logs, on their lists and ones still shared with them (a log on a
 * list they left stays, but out of sight). A person with tens of thousands of imported listening logs
 * makes every per-log check count, so the lists they can see are worked out once (a handful of ids) and
 * each query then needs only `items` for a log, never `categories` or a per-log share lookup. The
 * covering indexes on item_logs (see logs_user_date_source_idx and logs_user_source_date_idx) let
 * the day counts be read without touching the log rows at all.
 */

/** The ids of the lists the viewer sees (their own, and shared with them), narrowed to one when asked, as JSON */
export function visibleLists(userId: number, categoryId: number | null): string {
	const ids = (
		rawDb()
			.prepare(
				`SELECT id FROM categories WHERE user_id = @u
				 UNION SELECT category_id FROM list_shares WHERE user_id = @u`
			)
			.all({ u: userId }) as { id: number }[]
	).map((r) => r.id);
	return JSON.stringify(categoryId === null ? ids : ids.filter((id) => id === categoryId));
}

/** The item of log `l` is on a list in the bound JSON array of list ids (needs `items i`) */
export const IN_LISTS = 'i.category_id IN (SELECT value FROM json_each(?))';

/** First and last day anything was logged (for "All Time"). */
export function logBounds(userId: number, categoryId: number | null) {
	const sqlite = rawDb();
	const lists = visibleLists(userId, categoryId);
	const edge = (order: 'ASC' | 'DESC') =>
		(
			sqlite
				.prepare(
					`SELECT l.date FROM item_logs l INDEXED BY logs_user_date_source_idx
					 JOIN items i ON i.id = l.item_id
					 WHERE l.user_id = ? AND ${IN_LISTS} ORDER BY l.date ${order} LIMIT 1`
				)
				.get(userId, lists) as { date: string } | undefined
		)?.date ?? null;
	return { first: edge('ASC'), last: edge('DESC') };
}

export interface JournalResult<E extends JournalEntry> {
	stats: ReturnType<typeof journalStats>;
	heat: ReturnType<typeof heatmap>;
	entries: E[];
	more: boolean;
	/** Whether the viewer has any imported listening at all (to offer the choice of how to show it) */
	hasListening: boolean;
}

/** Days a streak is looked for at a time (it is rarely longer, so rarely reads more than one chunk) */
const STREAK_CHUNK = 60;
/** The longest current streak that can be told (as before) */
const STREAK_MAX = 4000;

/**
 * Everything the journal shows for a range: stats, the heatmap and the newest `limit` entries.
 * `listening` is how imported last.fm plays show: every album ('all', the default), left out ('hide'),
 * or one row per day ('group', where a listening day also counts as one entry in the stats and heatmap).
 */
export function journal(
	userId: number,
	range: DateRange,
	today: string,
	categoryId: number | null,
	limit: number,
	listening?: 'all' | 'hide'
): JournalResult<JournalLog>;
export function journal(
	userId: number,
	range: DateRange,
	today: string,
	categoryId: number | null,
	limit: number,
	listening: ListeningMode
): JournalResult<JournalEntry>;
export function journal(
	userId: number,
	range: DateRange,
	today: string,
	categoryId: number | null,
	limit: number,
	listening: ListeningMode = 'all'
): JournalResult<JournalEntry> {
	const sqlite = rawDb();
	const lists = visibleLists(userId, categoryId);
	// Hand-written logs have no source (imported ones say 'lastfm'). Hidden: imported listening is left
	// out of everything. Grouped: it's left out of the rows here, and each listening day comes back as
	// one row (and counts as one entry) instead.
	const notListening = listening !== 'all' ? ' AND l.source IS NULL' : '';
	// Hand-written logs are seeked by source; across everything the index walks days
	const scanIndex = notListening ? 'logs_user_source_date_idx' : 'logs_user_date_source_idx';

	const counts: Record<string, number> = {};
	for (const r of sqlite
		.prepare(
			`SELECT l.date, COUNT(*) AS n FROM item_logs l INDEXED BY ${scanIndex}
			 JOIN items i ON i.id = l.item_id
			 WHERE l.user_id = ? AND l.date BETWEEN ? AND ? AND ${IN_LISTS}${notListening} GROUP BY l.date`
		)
		.all(userId, range.from, range.to, lists) as { date: string; n: number }[]) {
		counts[r.date] = r.n;
	}
	if (listening === 'group') {
		// A listening day counts as one entry, however many albums it had
		for (const r of sqlite
			.prepare(
				`SELECT l.date FROM item_logs l INDEXED BY logs_user_source_date_idx
				 JOIN items i ON i.id = l.item_id
				 WHERE l.user_id = ? AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND ${IN_LISTS}
				 GROUP BY l.date`
			)
			.all(userId, range.from, range.to, lists) as { date: string }[]) {
			counts[r.date] = (counts[r.date] ?? 0) + 1;
		}
	}

	// The current streak counts every day ever logged, whatever the range: newest days first, a chunk at
	// a time, only as far back as the run of consecutive days goes
	const newestDays = sqlite.prepare(
		`SELECT l.date FROM item_logs l INDEXED BY ${scanIndex}
		 JOIN items i ON i.id = l.item_id
		 WHERE l.user_id = ? AND l.date < ? AND ${IN_LISTS}${notListening}
		 GROUP BY l.date ORDER BY l.date DESC LIMIT ?`
	);
	const activeDays: string[] = [];
	for (let before = addDays(today, 1); activeDays.length < STREAK_MAX;) {
		const chunk = (newestDays.all(userId, before, lists, STREAK_CHUNK) as { date: string }[]).map(
			(r) => r.date
		);
		let gap = false;
		for (const d of chunk) {
			if (activeDays.length && addDays(d, 1) !== activeDays[activeDays.length - 1]) gap = true;
			activeDays.push(d);
		}
		if (gap || chunk.length < STREAK_CHUNK) break;
		before = chunk[chunk.length - 1];
	}

	// Newest first. Grouped and hidden leave imported listening out; its index is the one that seeks
	// the hand-written logs directly, the other one walks days newest first
	const rows = sqlite
		.prepare(
			`SELECT l.id, l.date, l.rating, l.location, l.notes, l.external, ${logEpisodesSql('l')} AS ep,
				i.id AS item_id, i.title, i.subtitle,
				c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM item_logs l INDEXED BY ${notListening ? 'logs_user_source_date_idx' : 'logs_user_date_idx'}
			 JOIN items i ON i.id = l.item_id
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE l.user_id = ? AND l.date BETWEEN ? AND ? AND ${IN_LISTS}${notListening}
			 ORDER BY l.date DESC, l.id DESC
			 LIMIT ?`
		)
		.all(userId, range.from, range.to, lists, limit) as {
		id: number;
		date: string;
		rating: number | null;
		location: string | null;
		notes: string | null;
		external: string | null;
		ep: string;
		item_id: number;
		title: string;
		subtitle: string | null;
		category_name: string;
		category_icon: string;
		category_color: string;
		img_kind: ImageRef['kind'] | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];

	const logs: JournalLog[] = rows.map((r) => {
		// `external` is whatever a provider saved: anything that isn't the expected shape is just ignored
		let setlistSongs: number | null = null;
		let plays: number | null = null;
		try {
			const ext = r.external
				? (JSON.parse(r.external) as {
						setlist?: SetlistEvent;
						lastfm?: { plays?: number };
					} | null)
				: null;
			const songs = ext?.setlist?.songs;
			setlistSongs = Array.isArray(songs) ? songs.length : null;
			const n = ext?.lastfm?.plays;
			plays = typeof n === 'number' ? n : null;
		} catch {
			/* not JSON: neither a setlist nor listening */
		}
		return {
			kind: 'log' as const,
			id: r.id,
			date: r.date,
			rating: r.rating,
			location: r.location,
			notes: r.notes,
			setlistSongs,
			plays,
			episode: logEpisodeLabel(parseLogEpisodes(r.ep)),
			itemId: r.item_id,
			title: r.title,
			subtitle: r.subtitle,
			categoryName: r.category_name,
			categoryIcon: r.category_icon,
			categoryColor: r.category_color,
			imageUrl: r.img_kind
				? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
				: null
		};
	});

	const entries: JournalEntry[] =
		listening === 'group' ? [...logs, ...listeningDays(userId, range, lists, limit)] : logs;
	if (listening === 'group') {
		// Newest day first; on one day the hand-written logs come before the listening row
		entries.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
		entries.length = Math.min(entries.length, limit);
	}

	const stats = journalStats(counts, activeDays, today);
	return {
		stats,
		heat: heatmap(range, counts),
		entries,
		more: stats.total > entries.length,
		hasListening: !!sqlite
			.prepare(
				`SELECT 1 FROM item_logs l INDEXED BY logs_user_source_date_idx
				 JOIN items i ON i.id = l.item_id
				 WHERE l.user_id = ? AND l.source = 'lastfm' AND ${IN_LISTS} LIMIT 1`
			)
			.get(userId, lists)
	};
}

/** The newest `limit` days of imported listening in the range, one row each, with covers of the most played albums */
function listeningDays(userId: number, range: DateRange, lists: string, limit: number): JournalListening[] {
	const sqlite = rawDb();
	const days = sqlite
		.prepare(
			`SELECT l.date, COUNT(DISTINCT l.item_id) AS albums,
				COALESCE(SUM(json_extract(l.external, '$.lastfm.plays')), 0) AS tracks
			 FROM item_logs l INDEXED BY logs_user_source_date_idx
			 JOIN items i ON i.id = l.item_id
			 WHERE l.user_id = ? AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND ${IN_LISTS}
			 GROUP BY l.date ORDER BY l.date DESC LIMIT ?`
		)
		.all(userId, range.from, range.to, lists, limit) as {
		date: string;
		albums: number;
		tracks: number;
	}[];
	if (!days.length) return [];

	// The albums of those days with a picture, most played first (a day has few enough for this)
	const covers = new Map<string, string[]>();
	const rows = sqlite
		.prepare(
			`SELECT l.date, json_extract(l.external, '$.lastfm.plays') AS plays,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM item_logs l INDEXED BY logs_user_source_date_idx
			 JOIN items i ON i.id = l.item_id
			 JOIN images im ON im.id = i.cover_image_id
			 WHERE l.user_id = ? AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND ${IN_LISTS}
			 ORDER BY l.date DESC, plays DESC, i.id`
		)
		.all(userId, days[days.length - 1].date, days[0].date, lists) as {
		date: string;
		img_kind: ImageRef['kind'];
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];
	for (const r of rows) {
		const list = covers.get(r.date) ?? [];
		if (list.length >= 4) continue;
		const src = imageSrc({
			kind: r.img_kind,
			path: r.img_path,
			thumbPath: r.img_thumb,
			sourceUrl: r.img_source
		});
		// Albums can share artwork (or last.fm's stand-in picture): show each picture once
		if (src && !list.includes(src)) list.push(src);
		covers.set(r.date, list);
	}
	return days.map((d) => ({
		kind: 'listening' as const,
		id: `listening-${d.date}`,
		date: d.date,
		albums: d.albums,
		tracks: d.tracks,
		covers: covers.get(d.date) ?? []
	}));
}
