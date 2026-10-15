import { and, eq } from 'drizzle-orm';
import { db, rawDb, schema } from '../db';
import { igdbRelease } from '../providers/igdb';
import { getProvider } from '../providers/registry';
import { tmdbMovieRelease, tmdbTvReleases } from '../providers/tmdb';
import type { ReleaseInput } from '../providers/types';
import { RELEASE_KINDS, releaseLabel } from '$lib/calendar';
import { imageSrc, type ImageRef } from '$lib/images';
import type { StatusDef } from '$lib/types';

// Upcoming releases for the Calendar: air dates of TV episodes and release dates of movies and
// games, for items linked to TMDB or IGDB. Looked up on demand, daily, and when something is added.

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

interface Linked {
	id: number;
	provider: string;
	provider_kind: string;
	provider_id: string;
}

/** Items whose releases matter: linked to TMDB or IGDB, and not dropped. */
function linkedItems(userId: number, itemId?: number): Linked[] {
	const rows = rawDb()
		.prepare(
			`SELECT i.id, i.provider, i.provider_kind, i.provider_id, i.status, c.statuses
			 FROM items i JOIN categories c ON c.id = i.category_id
			 WHERE i.user_id = ? AND i.provider IN ('tmdb', 'igdb') AND i.provider_id IS NOT NULL
			 ${itemId ? 'AND i.id = ?' : ''}`
		)
		.all(...(itemId ? [userId, itemId] : [userId])) as (Linked & {
		status: string | null;
		statuses: string;
	})[];
	return rows.filter(
		(r) => !isDropped(r.statuses, r.status) && SOURCES.has(`${r.provider}:${r.provider_kind}`)
	);
}

function isDropped(statusesJson: string, status: string | null) {
	try {
		return (JSON.parse(statusesJson) as StatusDef[]).find((s) => s.key === status)?.group === 'dropped';
	} catch {
		return false;
	}
}

function replaceReleases(userId: number, itemId: number, list: ReleaseInput[]) {
	const seen = new Set<string>();
	db().transaction(() => {
		db().delete(schema.releases).where(eq(schema.releases.itemId, itemId)).run();
		for (const r of list) {
			const key = `${r.kind}|${r.date}|${r.season ?? ''}|${r.episode ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			db()
				.insert(schema.releases)
				.values({
					userId,
					itemId,
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
		db()
			.delete(schema.releases)
			.where(and(eq(schema.releases.userId, userId), eq(schema.releases.itemId, itemId)))
			.run();
		return 0;
	}
	const list = await lookup(item.provider_id);
	replaceReleases(userId, item.id, list);
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
					replaceReleases(userId, item.id, list);
					releases += list.length;
				} catch {
					failed++;
				}
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);

		// Items that were dropped or unlinked since the last look-up lose their releases
		const keep = new Set(items.map((i) => i.id));
		const stale = (
			rawDb().prepare('SELECT DISTINCT item_id FROM releases WHERE user_id = ?').all(userId) as {
				item_id: number;
			}[]
		).filter((r) => !keep.has(r.item_id));
		for (const r of stale) db().delete(schema.releases).where(eq(schema.releases.itemId, r.item_id)).run();

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

/** Releases between two days (inclusive) from lists shown in the Calendar, skipping dropped items. */
export function releasesBetween(userId: number, from: string, to: string, limit = 2000): CalendarEvent[] {
	const rows = rawDb()
		.prepare(
			`SELECT r.id, r.date, r.kind, r.season, r.episode, r.title AS episode_title,
				i.id AS item_id, i.title, i.status, c.statuses,
				c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM releases r
			 JOIN items i ON i.id = r.item_id
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE r.user_id = ? AND r.date BETWEEN ? AND ? AND c.show_in_calendar = 1
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
		status: string | null;
		statuses: string;
		category_name: string;
		category_icon: string;
		category_color: string;
		img_kind: ImageRef['kind'] | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];
	return rows
		.filter((r) => !isDropped(r.statuses, r.status))
		.map((r) => ({
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

/** Lists the Calendar can show: those holding shows, movies or games (by their sources or their items). */
export function calendarLists(userId: number) {
	const rows = rawDb()
		.prepare(
			`SELECT c.id, c.name, c.icon, c.slug, c.show_in_calendar, c.provider_kinds,
				(SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.provider IN ('tmdb', 'igdb')) AS linked
			 FROM categories c WHERE c.user_id = ? ORDER BY c.sort_order, c.name`
		)
		.all(userId) as {
		id: number;
		name: string;
		icon: string;
		slug: string;
		show_in_calendar: number;
		provider_kinds: string;
		linked: number;
	}[];
	return rows
		.filter((r) => r.linked > 0 || RELEASE_KINDS.some((k) => r.provider_kinds.includes(`"${k}"`)))
		.map((r) => ({
			id: r.id,
			name: r.name,
			icon: r.icon,
			slug: r.slug,
			shown: !!r.show_in_calendar,
			linked: r.linked
		}));
}

export function setListInCalendar(userId: number, categoryId: number, shown: boolean) {
	db()
		.update(schema.categories)
		.set({ showInCalendar: shown })
		.where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId)))
		.run();
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
