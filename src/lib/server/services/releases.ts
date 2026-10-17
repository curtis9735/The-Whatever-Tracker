import { eq, inArray } from 'drizzle-orm';
import { db, rawDb, schema } from '../db';
import { igdbRelease } from '../providers/igdb';
import { getProvider } from '../providers/registry';
import { tmdbMovieRelease, tmdbTvReleases } from '../providers/tmdb';
import type { ReleaseInput } from '../providers/types';
import { RELEASE_KINDS, releaseLabel } from '$lib/calendar';
import { imageSrc, type ImageRef } from '$lib/images';
import {
	listAccess,
	ME,
	MINE_IN_CALENDAR,
	mine,
	PROGRESS_JOIN,
	SEES_LIST,
	SHARE_JOIN,
	seesList,
	setMyListSettings
} from './access';

// Upcoming releases for the Calendar: air dates of TV episodes and release dates of movies and
// games, for items linked to TMDB or IGDB. Looked up on demand, daily, and when something is added.
// Release dates belong to the item, so they're kept under the item's owner (the list's owner) whoever
// looked them up, and everyone the list is shared with sees them in their own Calendar.

const SOURCES = new Map<string, (id: string) => Promise<ReleaseInput[]>>([
	['tmdb:tv', tmdbTvReleases],
	['tmdb:movie', tmdbMovieRelease],
	['igdb:game', igdbRelease]
]);

function sourceFor(provider: string | null, kind: string | null) {
	const lookup = SOURCES.get(`${provider}:${kind}`);
	return lookup && provider && getProvider(provider)?.enabled() ? lookup : null;
}

/** TMDB or IGDB is connected, so there is something to look releases up with. */
export function releaseSourcesReady() {
	return ['tmdb', 'igdb'].some((p) => getProvider(p)?.enabled());
}

/** SQL: `status` is one of list `c`'s "dropped" statuses (never true when there's no status) */
const droppedIn = (status: string) =>
	`EXISTS (SELECT 1 FROM json_each(c.statuses) st
		WHERE json_extract(st.value, '$.key') = ${status} AND json_extract(st.value, '$.group') = 'dropped')`;

interface Linked {
	id: number;
	/** The list's owner: the item and its releases are theirs */
	owner_id: number;
	provider: string;
	provider_kind: string;
	provider_id: string;
}

/**
 * Items whose releases matter to the viewer: on their lists or ones shared with them, linked to TMDB
 * or IGDB, and not dropped (by the viewer: on a shared list, their own status counts).
 */
function linkedItems(userId: number, itemId?: number): Linked[] {
	const rows = rawDb()
		.prepare(
			`SELECT i.id, i.user_id AS owner_id, i.provider, i.provider_kind, i.provider_id
			 FROM ${ME} CROSS JOIN items i
			 JOIN categories c ON c.id = i.category_id
			 ${SHARE_JOIN}
			 ${PROGRESS_JOIN}
			 WHERE ${SEES_LIST} AND i.provider IN ('tmdb', 'igdb') AND i.provider_id IS NOT NULL
				AND NOT ${droppedIn(mine('status'))}
			 ${itemId ? 'AND i.id = ?' : ''}`
		)
		.all(...(itemId ? [userId, itemId] : [userId])) as Linked[];
	return rows.filter((r) => SOURCES.has(`${r.provider}:${r.provider_kind}`));
}

/**
 * Of these items (only ones the viewer can see), those whose releases nobody needs any more: no
 * longer linked, or dropped by everyone who has the list (its owner and everyone it's shared with).
 */
function unwanted(userId: number, itemIds: number[]) {
	if (!itemIds.length) return [];
	const check = rawDb().prepare(
		`SELECT i.provider, i.provider_kind, i.provider_id,
			(NOT ${droppedIn('i.status')} OR EXISTS (
				SELECT 1 FROM list_shares s
				LEFT JOIN item_progress p ON p.item_id = i.id AND p.user_id = s.user_id
				WHERE s.category_id = c.id AND NOT ${droppedIn('p.status')})) AS followed
		 FROM ${ME} CROSS JOIN items i
		 JOIN categories c ON c.id = i.category_id
		 WHERE i.id = ? AND ${seesList()}`
	);
	return itemIds.filter((id) => {
		const r = check.get(userId, id) as
			| {
					provider: string | null;
					provider_kind: string | null;
					provider_id: string | null;
					followed: number;
			  }
			| undefined;
		if (!r) return false; // not the viewer's to tidy up
		return !r.followed || !r.provider_id || !SOURCES.has(`${r.provider}:${r.provider_kind}`);
	});
}

function forgetReleases(itemIds: number[]) {
	if (itemIds.length) db().delete(schema.releases).where(inArray(schema.releases.itemId, itemIds)).run();
}

/** Replaces an item's releases, for everyone who has it (they're kept under the item's owner) */
function replaceReleases(item: Linked, list: ReleaseInput[]) {
	const seen = new Set<string>();
	db().transaction(() => {
		db().delete(schema.releases).where(eq(schema.releases.itemId, item.id)).run();
		for (const r of list) {
			const key = `${r.kind}|${r.date}|${r.season ?? ''}|${r.episode ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			db()
				.insert(schema.releases)
				.values({
					userId: item.owner_id,
					itemId: item.id,
					kind: r.kind,
					date: r.date,
					season: r.season ?? null,
					episode: r.episode ?? null,
					title: r.title?.slice(0, 200) ?? null
				})
				.run();
		}
	});
}

/** Looks up one item's releases (right after it's added or linked). */
export async function refreshItemReleases(userId: number, itemId: number) {
	const [item] = linkedItems(userId, itemId);
	const lookup = item && sourceFor(item.provider, item.provider_kind);
	if (!lookup) {
		// Its source isn't connected: its dates go. Not linked, or dropped: unless someone else follows it
		forgetReleases(item ? [item.id] : unwanted(userId, [itemId]));
		return 0;
	}
	const list = await lookup(item.provider_id);
	replaceReleases(item, list);
	return list.length;
}

export interface RefreshResult {
	items: number;
	releases: number;
	failed: number;
}

const running = new Map<number, Promise<RefreshResult>>();

/** Looks up every release for an account. Only one lookup per account runs at a time. */
export function refreshReleases(userId: number): Promise<RefreshResult> {
	const already = running.get(userId);
	if (already) return already;
	const job = (async () => {
		const items = linkedItems(userId);
		const ready = items.filter((i) => sourceFor(i.provider, i.provider_kind));
		let releases = 0;
		let failed = 0;
		let next = 0;
		// A few at a time: quick, and well inside TMDB's and IGDB's limits
		const worker = async () => {
			while (next < ready.length) {
				const item = ready[next++];
				try {
					const list = await sourceFor(item.provider, item.provider_kind)!(item.provider_id);
					replaceReleases(item, list);
					releases += list.length;
				} catch {
					failed++;
				}
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);

		// Items that were dropped or unlinked since the last look-up lose their releases, unless
		// someone else who has the list still follows them
		const keep = new Set(items.map((i) => i.id));
		const stored = (
			rawDb()
				.prepare(
					`SELECT DISTINCT r.item_id FROM ${ME} CROSS JOIN releases r
					 JOIN items i ON i.id = r.item_id
					 JOIN categories c ON c.id = i.category_id
					 WHERE ${seesList()}`
				)
				.all(userId) as { item_id: number }[]
		).map((r) => r.item_id);
		forgetReleases(
			unwanted(
				userId,
				stored.filter((id) => !keep.has(id))
			)
		);

		db().update(schema.users).set({ releasesCheckedAt: new Date() }).where(eq(schema.users.id, userId)).run();
		return { items: ready.length, releases, failed };
	})().finally(() => running.delete(userId));
	running.set(userId, job);
	return job;
}

export function releasesCheckedAt(userId: number) {
	return (
		db()
			.select({ at: schema.users.releasesCheckedAt })
			.from(schema.users)
			.where(eq(schema.users.id, userId))
			.get()?.at ?? null
	);
}

export interface CalendarEvent {
	id: number;
	date: string;
	kind: 'episode' | 'movie' | 'game';
	/** "S11 E1", "Movie release"… */
	label: string;
	episodeTitle: string | null;
	itemId: number;
	title: string;
	categoryName: string;
	categoryIcon: string;
	categoryColor: string;
	imageUrl: string | null;
}

/**
 * Releases between two days (inclusive) from the viewer's lists and ones shared with them that they
 * show in the Calendar (their own choice), skipping items they've dropped.
 */
export function releasesBetween(userId: number, from: string, to: string, limit = 2000): CalendarEvent[] {
	const rows = rawDb()
		.prepare(
			`SELECT r.id, r.date, r.kind, r.season, r.episode, r.title AS episode_title,
				i.id AS item_id, i.title,
				c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM ${ME} CROSS JOIN releases r
			 JOIN items i ON i.id = r.item_id
			 JOIN categories c ON c.id = i.category_id
			 ${SHARE_JOIN}
			 ${PROGRESS_JOIN}
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE ${SEES_LIST} AND r.date BETWEEN ? AND ? AND ${MINE_IN_CALENDAR} = 1
				AND NOT ${droppedIn(mine('status'))}
			 ORDER BY r.date, i.title COLLATE NOCASE, r.season, r.episode
			 LIMIT ?`
		)
		.all(userId, from, to, limit) as {
		id: number;
		date: string;
		kind: CalendarEvent['kind'];
		season: number | null;
		episode: number | null;
		episode_title: string | null;
		item_id: number;
		title: string;
		category_name: string;
		category_icon: string;
		category_color: string;
		img_kind: ImageRef['kind'] | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];
	return rows.map((r) => ({
		id: r.id,
		date: r.date,
		kind: r.kind,
		label: releaseLabel(r),
		episodeTitle: r.episode_title,
		itemId: r.item_id,
		title: r.title,
		categoryName: r.category_name,
		categoryIcon: r.category_icon,
		categoryColor: r.category_color,
		imageUrl: r.img_kind
			? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
			: null
	}));
}

/**
 * Lists the Calendar can show: those holding shows, movies or games (by their sources or their items),
 * the viewer's first, then ones shared with them. `shown` is the viewer's own choice.
 */
export function calendarLists(userId: number) {
	const rows = rawDb()
		.prepare(
			`SELECT c.id, c.name, c.icon, c.slug, ${MINE_IN_CALENDAR} AS show_in_calendar, c.provider_kinds,
				IIF(c.user_id = me.id, NULL, u.display_name) AS owner_name, u.username AS owner_username,
				(SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.provider IN ('tmdb', 'igdb')) AS linked
			 FROM ${ME} CROSS JOIN categories c
			 JOIN users u ON u.id = c.user_id
			 ${SHARE_JOIN}
			 WHERE ${SEES_LIST}
			 ORDER BY c.user_id != me.id, IIF(c.user_id = me.id, c.sort_order, 0), c.name COLLATE NOCASE`
		)
		.all(userId) as {
		id: number;
		name: string;
		icon: string;
		slug: string;
		show_in_calendar: number;
		provider_kinds: string;
		owner_name: string | null;
		owner_username: string;
		linked: number;
	}[];
	return rows
		.filter((r) => r.linked > 0 || RELEASE_KINDS.some((k) => r.provider_kinds.includes(`"${k}"`)))
		.map((r) => ({
			id: r.id,
			name: r.name,
			icon: r.icon,
			/** How the viewer reaches it: `slug@owner` for a list shared with them */
			slug: r.owner_name === null ? r.slug : `${r.slug}@${r.owner_username}`,
			/** Whose list it is, when it isn't the viewer's */
			ownerName: r.owner_name,
			shown: !!r.show_in_calendar,
			linked: r.linked
		}));
}

/** The viewer's own choice to show a list's releases (lists they can't see are left alone) */
export function setListInCalendar(userId: number, categoryId: number, shown: boolean) {
	if (!listAccess(userId, categoryId)) return;
	setMyListSettings(userId, categoryId, { showInCalendar: shown });
}

// --- Daily look-up ----------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

/** Once an hour, refresh any account whose releases are more than a day old. */
export function startReleaseScheduler() {
	if (timer) return;
	const tick = async () => {
		if (!releaseSourcesReady()) return;
		const users = rawDb().prepare('SELECT id, releases_checked_at FROM users').all() as {
			id: number;
			releases_checked_at: number | null;
		}[];
		for (const u of users) {
			if (u.releases_checked_at && Date.now() - u.releases_checked_at < 22 * 3_600_000) continue;
			if (!linkedItems(u.id).length) continue;
			try {
				await refreshReleases(u.id);
			} catch (e) {
				console.error('[releases] look-up failed', e);
			}
		}
	};
	setTimeout(() => void tick(), 120_000).unref();
	timer = setInterval(() => void tick(), 60 * 60 * 1000);
	timer.unref();
}
