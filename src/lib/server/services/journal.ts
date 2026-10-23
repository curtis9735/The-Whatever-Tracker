import { rawDb } from '../db';
import { ME, seesList } from './access';
import { logEpisodesSql } from './items';
import { logEpisodeLabel, parseLogEpisodes } from '$lib/episodes';
import { imageSrc, type ImageRef } from '$lib/images';
import { heatmap, journalStats, type DateRange } from '$lib/journal';
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

/**
 * The viewer's own logs, on their lists and ones still shared with them (a log on a list they left
 * stays, but out of sight). Starts a query: bind the viewer's id first.
 */
const MY_LOGS = `FROM ${ME} CROSS JOIN item_logs l
	JOIN items i ON i.id = l.item_id
	JOIN categories c ON c.id = i.category_id`;
const IS_MY_LOG = `l.user_id = me.id AND ${seesList()}`;

/** First and last day anything was logged (for "All Time"). */
export function logBounds(userId: number, categoryId: number | null) {
	const row = rawDb()
		.prepare(
			`SELECT MIN(l.date) AS first, MAX(l.date) AS last ${MY_LOGS}
			 WHERE ${IS_MY_LOG} AND (? IS NULL OR i.category_id = ?)`
		)
		.get(userId, categoryId, categoryId) as { first: string | null; last: string | null };
	return row;
}

export interface JournalResult<E extends JournalEntry> {
	stats: ReturnType<typeof journalStats>;
	heat: ReturnType<typeof heatmap>;
	entries: E[];
	more: boolean;
	/** Whether the viewer has any imported listening at all (to offer the choice of how to show it) */
	hasListening: boolean;
}

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
	// Hidden: imported listening is left out of everything. Grouped: it's left out of the rows here,
	// and each listening day comes back as one row (and counts as one entry) instead.
	const scope = `(? IS NULL OR i.category_id = ?)${listening === 'hide' ? ' AND l.source IS NULL' : ''}`;
	const rowScope = `${scope}${listening === 'group' ? " AND l.source IS NOT 'lastfm'" : ''}`;
	const dayCount =
		listening === 'group'
			? "SUM(l.source IS NOT 'lastfm') + COALESCE(MAX(l.source IS 'lastfm'), 0)"
			: 'COUNT(*)';

	const counts: Record<string, number> = {};
	for (const r of sqlite
		.prepare(
			`SELECT l.date, ${dayCount} AS n ${MY_LOGS}
			 WHERE ${IS_MY_LOG} AND l.date BETWEEN ? AND ? AND ${scope} GROUP BY l.date`
		)
		.all(userId, range.from, range.to, categoryId, categoryId) as { date: string; n: number }[]) {
		counts[r.date] = r.n;
	}

	// The current streak counts every day ever logged, whatever the range
	const activeDays = (
		sqlite
			.prepare(
				`SELECT DISTINCT l.date ${MY_LOGS}
				 WHERE ${IS_MY_LOG} AND l.date <= ? AND ${scope} ORDER BY l.date DESC LIMIT 4000`
			)
			.all(userId, today, categoryId, categoryId) as { date: string }[]
	).map((r) => r.date);

	const rows = sqlite
		.prepare(
			`SELECT l.id, l.date, l.rating, l.location, l.notes, l.external, ${logEpisodesSql('l')} AS ep,
				i.id AS item_id, i.title, i.subtitle,
				c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 ${MY_LOGS}
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE ${IS_MY_LOG} AND l.date BETWEEN ? AND ? AND ${rowScope}
			 ORDER BY l.date DESC, l.id DESC
			 LIMIT ?`
		)
		.all(userId, range.from, range.to, categoryId, categoryId, limit) as {
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
		let setlistSongs: number | null = null;
		try {
			const sl = r.external ? (JSON.parse(r.external) as { setlist?: SetlistEvent }).setlist : undefined;
			setlistSongs = sl ? sl.songs.length : null;
		} catch {
			/* not a setlist */
		}
		let plays: number | null = null;
		try {
			const n = r.external
				? (JSON.parse(r.external) as { lastfm?: { plays?: number } }).lastfm?.plays
				: undefined;
			plays = typeof n === 'number' ? n : null;
		} catch {
			/* not listening */
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
		listening === 'group' ? [...logs, ...listeningDays(userId, range, categoryId, limit)] : logs;
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
		/** Whether the viewer has any imported listening at all (to offer the choice of how to show it) */
		hasListening: !!sqlite
			.prepare(`SELECT 1 ${MY_LOGS} WHERE ${IS_MY_LOG} AND l.source = 'lastfm' LIMIT 1`)
			.get(userId)
	};
}

/** The newest `limit` days of imported listening in the range, one row each, with covers of the most played albums */
function listeningDays(
	userId: number,
	range: DateRange,
	categoryId: number | null,
	limit: number
): JournalListening[] {
	const sqlite = rawDb();
	const days = sqlite
		.prepare(
			`SELECT l.date, COUNT(DISTINCT l.item_id) AS albums,
				COALESCE(SUM(json_extract(l.external, '$.lastfm.plays')), 0) AS tracks
			 ${MY_LOGS}
			 WHERE ${IS_MY_LOG} AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND (? IS NULL OR i.category_id = ?)
			 GROUP BY l.date ORDER BY l.date DESC LIMIT ?`
		)
		.all(userId, range.from, range.to, categoryId, categoryId, limit) as {
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
			 ${MY_LOGS}
			 JOIN images im ON im.id = i.cover_image_id
			 WHERE ${IS_MY_LOG} AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND (? IS NULL OR i.category_id = ?)
			 ORDER BY l.date DESC, plays DESC, i.id`
		)
		.all(userId, days[days.length - 1].date, days[0].date, categoryId, categoryId) as {
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
		if (src) list.push(src);
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
