import type { Category, Item } from '../db/schema';
import { rawDb } from '../db';
import { searchSetlists, setlistfmEnabled, type SetlistQuery } from '../providers/setlistfm';
import { ME, PROGRESS_JOIN, mine, seesList } from './access';
import { addLog, getItem, type LogInput } from './items';
import { imageSrc, type ImageRef } from '$lib/images';
import { SETLIST_SOURCE } from '$lib/kinds';
import type { SetlistEvent } from '$lib/types';

/** List `c` is a concert list: the Concerts template, or any list of last.fm artists (SQL, needs `categories c`) */
export const CONCERT_LIST = `(c.template_key = 'concerts' OR c.provider_kinds LIKE '%"lastfm:artist"%')`;

/** The list is a concert list the viewer can see */
export function isConcertList(userId: number, categoryId: number): boolean {
	return !!rawDb()
		.prepare(
			`SELECT 1 FROM ${ME} CROSS JOIN categories c WHERE c.id = ? AND ${CONCERT_LIST} AND ${seesList()}`
		)
		.get(userId, categoryId);
}

/** A list opts in to setlist lookups under List settings → Sources (on by default for Concerts). */
export function listUsesSetlists(category: Pick<Category, 'providerKinds'>) {
	return category.providerKinds.includes(SETLIST_SOURCE);
}

export function canFindSetlists(_item: Item, category: Category) {
	return setlistfmEnabled() && listUsesSetlists(category);
}

/**
 * Exact MusicBrainz ID when we have one (a MusicBrainz artist, or a last.fm artist that came
 * with one); otherwise search setlist.fm by the item's name.
 */
export function setlistArtist(item: Item): SetlistQuery['artist'] {
	if (item.provider === 'musicbrainz' && item.providerKind === 'artist' && item.providerId) {
		return { mbid: item.providerId };
	}
	if (item.provider === 'lastfm' && item.providerKind === 'artist') {
		const mbid = (item.metadata as { mbid?: unknown } | null)?.mbid;
		if (typeof mbid === 'string' && mbid) return { mbid };
	}
	return { name: item.title };
}

export function showPlace(e: SetlistEvent) {
	return [e.venue, e.city].filter(Boolean).join(', ');
}

/**
 * What happened when looking up the show for a new log:
 * attached (one show that day, saved with the log), several (the user picks), none (not on
 * setlist.fm yet), failed (setlist.fm unreachable), off (not a setlist list, or no key).
 */
export type ShowLookup = 'attached' | 'several' | 'none' | 'failed' | 'off';

/**
 * Adds a log, and for concert lists attaches the setlist.fm show from that day when there's
 * exactly one. The log is saved either way, so the date is never lost.
 */
export async function addLogWithShow(
	userId: number,
	itemId: number,
	category: Category,
	input: LogInput
): Promise<{ log: ReturnType<typeof addLog>; show: ShowLookup }> {
	// Logs are each person's own, so seeing the list is enough
	const item = getItem(userId, itemId);
	let show: ShowLookup = 'off';
	let entry = input;
	if (canFindSetlists(item, category) && !input.external) {
		try {
			const { events } = await searchSetlists({ artist: setlistArtist(item), date: input.date });
			if (events.length === 1) {
				const e = events[0];
				entry = { ...input, location: input.location || showPlace(e), external: { setlist: e } };
				show = 'attached';
			} else {
				show = events.length ? 'several' : 'none';
			}
		} catch {
			show = 'failed';
		}
	}
	return { log: addLog(userId, itemId, entry, category.statuses), show };
}

export const SHOW_LOOKUP_FAILED =
	"Saved, but setlist.fm couldn't be reached. Use “Find the setlist” on the show to try again.";

/** Where to go after adding: straight to picking the show when setlist.fm has several that day. */
export function afterAddPath(itemId: number, logId: number | null, show: ShowLookup | null) {
	if (show === 'several' && logId) return `/logs/${logId}/edit?pick=1`;
	if (show === 'failed') return `/items/${itemId}?${new URLSearchParams({ warn: SHOW_LOOKUP_FAILED })}`;
	return `/items/${itemId}`;
}

/** One concert the viewer went to: a log on an artist in a concert list */
export interface ShowRow {
	logId: number;
	itemId: number;
	date: string;
	artist: string;
	coverUrl: string | null;
	/** Stored rating (0-100 in tens) */
	rating: number | null;
	tour: string | null;
	/** Where it was: the log's own location, else the setlist's venue and city */
	place: string;
	/** Songs on the attached setlist, or null without one */
	songs: number | null;
}

export interface ShowFilters {
	q?: string | null;
	status?: string | null;
	tag?: string | null;
	minRating?: number | null;
	favorite?: boolean;
	page?: number;
	pageSize?: number;
}

/** `external` is whatever a provider saved: anything that isn't a setlist is ignored */
function parseSetlist(external: string | null): SetlistEvent | null {
	if (!external) return null;
	try {
		const sl = (JSON.parse(external) as { setlist?: SetlistEvent } | null)?.setlist;
		return sl && typeof sl === 'object' ? sl : null;
	} catch {
		return null;
	}
}

/**
 * The viewer's own concert logs on a list, newest first. Logs are each person's own, so someone a
 * list is shared with never sees the owner's shows (nor the owner theirs). The item filters (status,
 * tag, favorite, minimum rating) are the viewer's own view of the artist. `years` counts the whole
 * filtered set, not just the page, for the year headings.
 */
export function listShows(userId: number, categoryId: number, f: ShowFilters = {}) {
	if (!isConcertList(userId, categoryId)) {
		return { rows: [] as ShowRow[], total: 0, years: [] as { year: string; count: number }[] };
	}
	const where: string[] = ['i.category_id = ?', 'l.user_id = me.id', seesList()];
	const params: unknown[] = [categoryId];
	if (f.status) {
		where.push(`${mine('status')} = ?`);
		params.push(f.status);
	}
	if (f.tag) {
		where.push(
			'EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name = ?)'
		);
		params.push(f.tag);
	}
	if (f.minRating !== null && f.minRating !== undefined) {
		where.push(`${mine('rating')} >= ?`);
		params.push(f.minRating);
	}
	if (f.favorite) where.push(`${mine('favorite')} = 1`);
	if (f.q) {
		const like = `%${f.q.replace(/[!%_]/g, '!$&')}%`;
		const cols = [
			'i.title',
			'l.location',
			"json_extract(l.external, '$.setlist.venue')",
			"json_extract(l.external, '$.setlist.city')",
			"json_extract(l.external, '$.setlist.tour')"
		];
		where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '!'`).join(' OR ')})`);
		params.push(...cols.map(() => like));
	}
	const sqlite = rawDb();
	const from = `FROM ${ME} CROSS JOIN item_logs l JOIN items i ON i.id = l.item_id
		JOIN categories c ON c.id = i.category_id ${PROGRESS_JOIN}`;
	const years = sqlite
		.prepare(
			`SELECT substr(l.date, 1, 4) AS year, COUNT(*) AS count ${from}
			 WHERE ${where.join(' AND ')} GROUP BY 1 ORDER BY 1 DESC`
		)
		.all(userId, ...params) as { year: string; count: number }[];
	const total = years.reduce((n, y) => n + y.count, 0);

	const pageSize = f.pageSize ?? 60;
	const page = Math.max(1, f.page ?? 1);
	const rows = (
		sqlite
			.prepare(
				`SELECT l.id, l.date, l.rating, l.location, l.external, i.id AS item_id, i.title,
					im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
				 ${from} LEFT JOIN images im ON im.id = i.cover_image_id
				 WHERE ${where.join(' AND ')}
				 ORDER BY l.date DESC, l.id DESC
				 LIMIT ? OFFSET ?`
			)
			.all(userId, ...params, pageSize, (page - 1) * pageSize) as {
			id: number;
			date: string;
			rating: number | null;
			location: string | null;
			external: string | null;
			item_id: number;
			title: string;
			img_kind: ImageRef['kind'] | null;
			img_path: string | null;
			img_thumb: string | null;
			img_source: string | null;
		}[]
	).map((r): ShowRow => {
		const sl = parseSetlist(r.external);
		return {
			logId: r.id,
			itemId: r.item_id,
			date: r.date,
			artist: r.title,
			coverUrl: r.img_kind
				? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
				: null,
			rating: r.rating,
			tour: sl?.tour || null,
			place: r.location || (sl ? showPlace(sl) : ''),
			songs: sl && Array.isArray(sl.songs) ? sl.songs.length : null
		};
	});
	return { rows, total, years };
}
