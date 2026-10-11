import { parse } from 'csv-parse/sync';
import { and, eq } from 'drizzle-orm';
import { db, rawDb, schema } from '../db';
import { reindexItem } from '../search/local';
import { createCategory, createCategoryFromTemplate, listCategories } from '../services/categories';
import { findExisting } from '../services/provider-items';
import { TEMPLATE_BY_KEY } from '../templates';
import type { StatusDef, StatusGroup } from '$lib/types';

// Yamtrack's CSV export: one row per tracked media record, columns by header name
// (media_id, source, media_type, title, image, season_number, episode_number,
//  score, progress, status, start_date, end_date, notes, created_at, progressed_at).

type MainType = 'movie' | 'tv' | 'game' | 'boardgame' | 'anime' | 'manga' | 'book' | 'comic';

const TEMPLATE_FOR: Partial<Record<MainType, string>> = {
	movie: 'movies',
	tv: 'tv-shows',
	game: 'video-games',
	boardgame: 'board-games'
};

const GENERIC: Record<string, { name: string; icon: string; color: string }> = {
	anime: { name: 'Anime', icon: '🍥', color: 'pink' },
	manga: { name: 'Manga', icon: '📚', color: 'violet' },
	book: { name: 'Books', icon: '📖', color: 'emerald' },
	comic: { name: 'Comics', icon: '💥', color: 'red' }
};

/** Sources this app can refresh metadata from, by Yamtrack media type. */
const LIVE: Record<string, string[]> = { tmdb: ['movie', 'tv'], igdb: ['game'], bgg: ['boardgame'] };

const YAM_GROUP: Record<string, StatusGroup> = {
	completed: 'done',
	'in progress': 'active',
	planning: 'planned',
	paused: 'active',
	dropped: 'dropped'
};

const YAMTRACK_STATUSES: StatusDef[] = [
	{ key: 'planning', label: 'Planning', group: 'planned' },
	{ key: 'in-progress', label: 'In progress', group: 'active' },
	{ key: 'completed', label: 'Completed', group: 'done' },
	{ key: 'paused', label: 'Paused', group: 'active' },
	{ key: 'dropped', label: 'Dropped', group: 'dropped' }
];

export interface PlannedLog {
	date: string;
	rating: number | null;
	notes: string | null;
}

export interface PlannedItem {
	key: string;
	mediaType: MainType;
	title: string;
	image: string | null;
	status: string | null;
	rating: number | null;
	notes: string | null;
	provider: string;
	providerKind: string;
	providerId: string;
	externalUrl: string | null;
	logs: PlannedLog[];
	progress: { season: number; episode: number } | null;
}

export interface ImportPlan {
	items: PlannedItem[];
	counts: Record<string, { items: number; logs: number }>;
	skipped: number;
	rows: number;
}

export class ImportError extends Error {}

function dateOnly(v: string | undefined) {
	const m = v?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : null;
}

function scoreToRating(v: string | undefined) {
	if (!v?.trim()) return null;
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.round(Math.min(Math.max(n, 0), 10) * 10);
}

function externalUrl(source: string, type: string, id: string): string | null {
	switch (source) {
		case 'tmdb':
			return `https://www.themoviedb.org/${type === 'movie' ? 'movie' : 'tv'}/${id}`;
		case 'mal':
			return `https://myanimelist.net/${type === 'manga' ? 'manga' : 'anime'}/${id}`;
		case 'bgg':
			return `https://boardgamegeek.com/boardgame/${id}`;
		case 'openlibrary':
			return `https://openlibrary.org/works/${id}`;
		case 'mangaupdates':
			return `https://www.mangaupdates.com/series/${id}`;
		default:
			return null;
	}
}

/** Pure: turns CSV text into a list of items + logs to write. */
export function planYamtrackImport(csv: string): ImportPlan {
	let rows: Record<string, string>[];
	try {
		rows = parse(csv, {
			columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
			skip_empty_lines: true,
			bom: true,
			relax_column_count: true,
			trim: true
		});
	} catch {
		throw new ImportError('Could not read that file as CSV.');
	}
	if (!rows.length || !('media_type' in rows[0]) || !('title' in rows[0]) || !('media_id' in rows[0])) {
		throw new ImportError(
			'This does not look like a Yamtrack export (expected media_id, media_type and title columns).'
		);
	}

	const items = new Map<string, PlannedItem>();
	const latestEnd = new Map<string, string>();
	// Shows tracked only per season (no show row) take the status of their latest season
	const seasonStatus = new Map<string, { when: string; status: string }>();
	let skipped = 0;

	for (const row of rows) {
		const rawType = (row.media_type || '').toLowerCase();
		const isChild = rawType === 'season' || rawType === 'episode';
		const type = (isChild ? 'tv' : rawType) as MainType;
		if (!(type in TEMPLATE_FOR) && !(type in GENERIC)) {
			skipped++;
			continue;
		}
		const source = (row.source || 'manual').toLowerCase();
		const mediaId = row.media_id;
		if (!mediaId) {
			skipped++;
			continue;
		}
		const live = LIVE[source]?.includes(type);
		const provider = live ? source : source === 'manual' ? 'yamtrack' : source;
		const key = `${provider}:${type}:${mediaId}`;

		let item = items.get(key);
		if (!item) {
			item = {
				key,
				mediaType: type,
				title: row.title || 'Untitled',
				image: null,
				status: null,
				rating: null,
				notes: null,
				provider,
				providerKind: type,
				providerId: mediaId,
				externalUrl: externalUrl(source, type, mediaId),
				logs: [],
				progress: null
			};
			items.set(key, item);
		}

		const start = dateOnly(row.start_date);
		const end = dateOnly(row.end_date);
		const rating = scoreToRating(row.score);

		if (rawType === 'episode') {
			const s = Number(row.season_number) || 0;
			const e = Number(row.episode_number) || 0;
			const p = item.progress;
			if (!p || s > p.season || (s === p.season && e > p.episode)) item.progress = { season: s, episode: e };
			continue;
		}

		if (rawType === 'season') {
			const date = end || start;
			const prev = seasonStatus.get(key);
			if (row.status && (!prev || (date ?? '') >= prev.when)) {
				seasonStatus.set(key, { when: date ?? '', status: row.status });
			}
			if (date) {
				const n = row.season_number;
				item.logs.push({ date, rating, notes: `Season ${n}${end ? '' : ' (started)'}` });
			}
			continue;
		}

		// Main record. Repeats appear as several rows; the most recent one sets status and score.
		if (row.title) item.title = row.title;
		if (/^https?:\/\//i.test(row.image || '') && !item.image) item.image = row.image;
		const when = end || start || '';
		if (!latestEnd.has(key) || when >= (latestEnd.get(key) ?? '')) {
			latestEnd.set(key, when);
			if (row.status) item.status = row.status;
			if (rating !== null) item.rating = rating;
		}
		if (row.notes) {
			item.notes =
				item.notes && !item.notes.includes(row.notes) ? `${item.notes}\n\n${row.notes}` : row.notes;
		}
		if (end || start) item.logs.push({ date: (end || start)!, rating, notes: end ? null : 'Started' });
	}

	const counts: ImportPlan['counts'] = {};
	for (const item of items.values()) {
		if (!item.status) {
			item.status = seasonStatus.get(item.key)?.status ?? (item.progress ? 'In progress' : null);
		}
		const seen = new Set<string>();
		item.logs = item.logs.filter((l) => {
			const k = `${l.date}|${l.notes ?? ''}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const c = (counts[item.mediaType] ??= { items: 0, logs: 0 });
		c.items++;
		c.logs += item.logs.length;
	}
	return { items: [...items.values()], counts, skipped, rows: rows.length };
}

function mapStatus(statuses: StatusDef[], yam: string | null): string | null {
	if (!statuses.length) return null;
	if (!yam) return statuses[0].key;
	const lower = yam.toLowerCase();
	const byLabel = statuses.find((s) => s.label.toLowerCase() === lower || s.key === lower);
	if (byLabel) return byLabel.key;
	const group = YAM_GROUP[lower];
	return statuses.find((s) => s.group === group)?.key ?? statuses[0].key;
}

export const MEDIA_TYPE_LABELS: Record<string, string> = {
	movie: 'Movies',
	tv: 'TV Shows',
	game: 'Video Games',
	boardgame: 'Board Games',
	anime: 'Anime',
	manga: 'Manga',
	book: 'Books',
	comic: 'Comics'
};

/** Finds (without creating) the category each media type would go into. */
export function resolveTargets(userId: number, types: string[]) {
	const cats = listCategories(userId);
	const out: Record<string, { categoryId: number | null; name: string }> = {};
	for (const t of types) {
		const template = TEMPLATE_FOR[t as MainType];
		const kindKey =
			t === 'movie'
				? 'tmdb:movie'
				: t === 'tv'
					? 'tmdb:tv'
					: t === 'game'
						? 'igdb:game'
						: t === 'boardgame'
							? 'bgg:boardgame'
							: null;
		const found =
			(kindKey && cats.find((c) => c.providerKinds.includes(kindKey))) ||
			cats.find(
				(c) =>
					c.name.toLowerCase() ===
					(GENERIC[t]?.name ?? TEMPLATE_BY_KEY.get(template ?? '')?.name ?? '').toLowerCase()
			);
		out[t] = found
			? { categoryId: found.id, name: found.name }
			: { categoryId: null, name: GENERIC[t]?.name ?? TEMPLATE_BY_KEY.get(template ?? '')?.name ?? t };
	}
	return out;
}

export function previewYamtrackImport(userId: number, plan: ImportPlan) {
	const targets = resolveTargets(userId, Object.keys(plan.counts));
	return Object.entries(plan.counts).map(([type, c]) => {
		const existing = plan.items.filter(
			(i) => i.mediaType === type && findExisting(userId, i.provider, i.providerKind, i.providerId)
		).length;
		return {
			type,
			label: MEDIA_TYPE_LABELS[type] ?? type,
			category: targets[type].name,
			newCategory: targets[type].categoryId === null,
			items: c.items,
			existing,
			logs: c.logs
		};
	});
}

export function applyYamtrackImport(userId: number, plan: ImportPlan) {
	// Categories first (they use their own transactions)
	const targets = resolveTargets(userId, Object.keys(plan.counts));
	const categoryIds: Record<string, number> = {};
	const createdCategories: string[] = [];
	for (const [type, target] of Object.entries(targets)) {
		if (target.categoryId) {
			categoryIds[type] = target.categoryId;
			continue;
		}
		const template = TEMPLATE_FOR[type as MainType];
		const cat = template
			? createCategoryFromTemplate(userId, template)
			: createCategory(userId, {
					...GENERIC[type],
					ratingScale: '10',
					statuses: YAMTRACK_STATUSES,
					providerKinds: []
				});
		categoryIds[type] = cat.id;
		createdCategories.push(cat.name);
	}
	const statusesFor = new Map(listCategories(userId).map((c) => [c.id, c.statuses]));

	let created = 0;
	let updated = 0;
	let logsAdded = 0;
	const touched: number[] = [];

	db().transaction(() => {
		for (const p of plan.items) {
			const categoryId = categoryIds[p.mediaType];
			const statuses = statusesFor.get(categoryId) ?? [];
			const status = mapStatus(statuses, p.status);
			const existingId = findExisting(userId, p.provider, p.providerKind, p.providerId);
			let itemId: number;

			if (existingId) {
				const cur = db().select().from(schema.items).where(eq(schema.items.id, existingId)).get()!;
				const custom = { ...cur.custom };
				if (p.progress) {
					custom.current_season = p.progress.season;
					custom.current_episode = p.progress.episode;
				}
				db()
					.update(schema.items)
					.set({
						status,
						rating: p.rating ?? cur.rating,
						notes: cur.notes || p.notes,
						custom,
						updatedAt: new Date()
					})
					.where(eq(schema.items.id, existingId))
					.run();
				itemId = existingId;
				updated++;
			} else {
				const custom: Record<string, unknown> = {};
				if (p.progress) {
					custom.current_season = p.progress.season;
					custom.current_episode = p.progress.episode;
				}
				const row = db()
					.insert(schema.items)
					.values({
						userId,
						categoryId,
						title: p.title,
						status,
						rating: p.rating,
						notes: p.notes,
						custom,
						provider: p.provider,
						providerKind: p.providerKind,
						providerId: p.providerId,
						externalUrl: p.externalUrl
					})
					.returning({ id: schema.items.id })
					.get();
				itemId = row.id;
				created++;
				if (p.image) {
					const img = db()
						.insert(schema.images)
						.values({ userId, itemId, kind: 'url_link', sourceUrl: p.image })
						.returning({ id: schema.images.id })
						.get();
					db().update(schema.items).set({ coverImageId: img.id }).where(eq(schema.items.id, itemId)).run();
				}
			}

			for (const l of p.logs) {
				const dup = db()
					.select({ id: schema.itemLogs.id, notes: schema.itemLogs.notes })
					.from(schema.itemLogs)
					.where(and(eq(schema.itemLogs.itemId, itemId), eq(schema.itemLogs.date, l.date)))
					.all()
					.some((x) => (x.notes ?? null) === (l.notes ?? null));
				if (dup) continue;
				db()
					.insert(schema.itemLogs)
					.values({ itemId, userId, date: l.date, rating: l.rating, notes: l.notes })
					.run();
				logsAdded++;
			}
			rawDb()
				.prepare(
					'UPDATE items SET last_logged_at = (SELECT MAX(date) FROM item_logs WHERE item_id = ?) WHERE id = ?'
				)
				.run(itemId, itemId);
			touched.push(itemId);
		}
	});

	for (const id of touched) reindexItem(id);
	return { created, updated, logsAdded, createdCategories };
}
