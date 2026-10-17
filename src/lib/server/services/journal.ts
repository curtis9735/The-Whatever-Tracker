import { rawDb } from '../db';
import { ME, seesList } from './access';
import { logEpisodesSql } from './items';
import { logEpisodeLabel, parseLogEpisodes } from '$lib/episodes';
import { imageSrc, type ImageRef } from '$lib/images';
import { heatmap, journalStats, type DateRange } from '$lib/journal';
import type { SetlistEvent } from '$lib/types';

export interface JournalEntry {
	id: number;
	date: string;
	rating: number | null;
	location: string | null;
	notes: string | null;
	setlistSongs: number | null;
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

/** Everything the journal shows for a range: stats, the heatmap and the newest `limit` entries. */
export function journal(
	userId: number,
	range: DateRange,
	today: string,
	categoryId: number | null,
	limit: number
) {
	const sqlite = rawDb();
	const scope = '(? IS NULL OR i.category_id = ?)';

	const counts: Record<string, number> = {};
	for (const r of sqlite
		.prepare(
			`SELECT l.date, COUNT(*) AS n ${MY_LOGS}
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
			 WHERE ${IS_MY_LOG} AND l.date BETWEEN ? AND ? AND ${scope}
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

	const entries: JournalEntry[] = rows.map((r) => {
		let setlistSongs: number | null = null;
		try {
			const sl = r.external ? (JSON.parse(r.external) as { setlist?: SetlistEvent }).setlist : undefined;
			setlistSongs = sl ? sl.songs.length : null;
		} catch {
			/* not a setlist */
		}
		return {
			id: r.id,
			date: r.date,
			rating: r.rating,
			location: r.location,
			notes: r.notes,
			setlistSongs,
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

	const stats = journalStats(counts, activeDays, today);
	return { stats, heat: heatmap(range, counts), entries, more: stats.total > entries.length };
}
