import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db, rawDb, schema } from '../db';
import { reindexItem } from '../search/local';
import { deleteStoredFiles, storeImageFromUrl, storeUploadedFile, type StoredImage } from '../images/store';
import { getCategoryById } from './categories';
import type { Image, Item } from '../db/schema';
import type { StatusDef } from '$lib/types';
import { EPISODE_ORDER, parseLogEpisodes } from '$lib/episodes';

export interface ItemInput {
	categoryId: number;
	title: string;
	subtitle?: string | null;
	description?: string | null;
	status?: string | null;
	rating?: number | null;
	favorite?: boolean;
	barcode?: string | null;
	notes?: string | null;
	custom?: Record<string, unknown>;
	provider?: string | null;
	providerKind?: string | null;
	providerId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
}

export function getOwnedItem(userId: number, itemId: number): Item {
	const item = db()
		.select()
		.from(schema.items)
		.where(and(eq(schema.items.id, itemId), eq(schema.items.userId, userId)))
		.get();
	if (!item) error(404, 'Item not found');
	return item;
}

export function createItem(userId: number, input: ItemInput, tagNames: string[] = []) {
	// Throws 404 if the category is not this user's
	getCategoryById(userId, input.categoryId);
	const now = new Date();
	const item = db()
		.insert(schema.items)
		.values({
			userId,
			categoryId: input.categoryId,
			title: input.title,
			subtitle: input.subtitle || null,
			description: input.description || null,
			status: input.status || null,
			rating: input.rating ?? null,
			favorite: input.favorite ?? false,
			barcode: input.barcode || null,
			notes: input.notes || null,
			custom: input.custom ?? {},
			provider: input.provider || null,
			providerKind: input.providerKind || null,
			providerId: input.providerId || null,
			externalUrl: input.externalUrl || null,
			metadata: input.metadata ?? null,
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	setTags(userId, item.id, tagNames);
	return item;
}

export function updateItem(userId: number, itemId: number, patch: Partial<ItemInput>, tagNames?: string[]) {
	const item = getOwnedItem(userId, itemId);
	if (patch.categoryId !== undefined && patch.categoryId !== item.categoryId) {
		getCategoryById(userId, patch.categoryId);
	}
	db()
		.update(schema.items)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(schema.items.id, itemId))
		.run();
	if (tagNames) setTags(userId, itemId, tagNames);
	else reindexItem(itemId);
}

export async function deleteItem(userId: number, itemId: number) {
	getOwnedItem(userId, itemId);
	const imgs = db()
		.select()
		.from(schema.images)
		.where(
			sql`${schema.images.itemId} = ${itemId} OR ${schema.images.logId} IN (SELECT id FROM item_logs WHERE item_id = ${itemId})`
		)
		.all();
	db().delete(schema.items).where(eq(schema.items.id, itemId)).run();
	for (const img of imgs) await deleteStoredFiles(img);
}

export function parseTagInput(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return Array.from(
		new Set(
			raw
				.split(',')
				.map((t) => t.trim().replace(/\s+/g, ' ').slice(0, 40))
				.filter(Boolean)
		)
	).slice(0, 30);
}

export function setTags(userId: number, itemId: number, names: string[]) {
	db().transaction(() => {
		db().delete(schema.itemTags).where(eq(schema.itemTags.itemId, itemId)).run();
		for (const name of names) {
			db().insert(schema.tags).values({ userId, name }).onConflictDoNothing().run();
			const tag = db()
				.select({ id: schema.tags.id })
				.from(schema.tags)
				.where(and(eq(schema.tags.userId, userId), eq(schema.tags.name, name)))
				.get();
			if (tag) db().insert(schema.itemTags).values({ itemId, tagId: tag.id }).onConflictDoNothing().run();
		}
		// Drop tags nobody uses any more
		db()
			.delete(schema.tags)
			.where(
				and(
					eq(schema.tags.userId, userId),
					sql`NOT EXISTS (SELECT 1 FROM item_tags WHERE item_tags.tag_id = tags.id)`
				)
			)
			.run();
	});
	reindexItem(itemId);
}

export function getItemTags(itemId: number) {
	return db()
		.select({ name: schema.tags.name })
		.from(schema.itemTags)
		.innerJoin(schema.tags, eq(schema.tags.id, schema.itemTags.tagId))
		.where(eq(schema.itemTags.itemId, itemId))
		.orderBy(asc(schema.tags.name))
		.all()
		.map((t) => t.name);
}

export function listUserTags(userId: number) {
	return db()
		.select({ name: schema.tags.name })
		.from(schema.tags)
		.where(eq(schema.tags.userId, userId))
		.orderBy(asc(schema.tags.name))
		.all()
		.map((t) => t.name);
}

export function getItemDetail(userId: number, itemId: number) {
	const item = getOwnedItem(userId, itemId);
	const cat = getCategoryById(userId, item.categoryId);
	const logs = db()
		.select()
		.from(schema.itemLogs)
		.where(eq(schema.itemLogs.itemId, itemId))
		.orderBy(desc(schema.itemLogs.date), desc(schema.itemLogs.id))
		.all();
	const logIds = logs.map((l) => l.id);
	const itemImages = db()
		.select()
		.from(schema.images)
		.where(eq(schema.images.itemId, itemId))
		.orderBy(asc(schema.images.sortOrder), asc(schema.images.id))
		.all();
	const logImages = logIds.length
		? db()
				.select()
				.from(schema.images)
				.where(inArray(schema.images.logId, logIds))
				.orderBy(asc(schema.images.id))
				.all()
		: [];
	const cover = itemImages.find((i) => i.id === item.coverImageId) ?? itemImages[0] ?? null;
	const episodes = new Map(
		(
			rawDb()
				.prepare(
					`SELECT l.id, ${logEpisodesSql('l')} AS ep FROM item_logs l
					 WHERE l.item_id = ? AND EXISTS (SELECT 1 FROM episode_watches w WHERE w.log_id = l.id)`
				)
				.all(itemId) as { id: number; ep: string }[]
		).map((r) => [r.id, parseLogEpisodes(r.ep)])
	);
	return {
		item,
		...cat,
		tags: getItemTags(itemId),
		images: itemImages,
		cover,
		logs: logs.map((l) => ({
			...l,
			images: logImages.filter((i) => i.logId === l.id),
			episodes: episodes.get(l.id) ?? null
		}))
	};
}

// --- Images -------------------------------------------------------------------------

export type ImageSource = { type: 'file'; file: File } | { type: 'url'; url: string; linkOnly: boolean };

export async function addImage(
	userId: number,
	target: { itemId: number } | { logId: number },
	source: ImageSource
): Promise<Image> {
	let stored: StoredImage | null = null;
	let kind: Image['kind'];
	let sourceUrl: string | null = null;

	if (source.type === 'file') {
		stored = await storeUploadedFile(userId, source.file);
		kind = 'upload';
	} else if (source.linkOnly) {
		const url = source.url.trim();
		if (!/^https?:\/\//i.test(url)) throw new Error('Image links must start with http:// or https://');
		kind = 'url_link';
		sourceUrl = url;
	} else {
		stored = await storeImageFromUrl(userId, source.url.trim());
		kind = 'url_copy';
		sourceUrl = source.url.trim();
	}

	const itemId = 'itemId' in target ? target.itemId : null;
	const logId = 'logId' in target ? target.logId : null;
	const img = db()
		.insert(schema.images)
		.values({
			userId,
			itemId,
			logId,
			kind,
			path: stored?.path ?? null,
			thumbPath: stored?.thumbPath ?? null,
			sourceUrl,
			width: stored?.width ?? null,
			height: stored?.height ?? null,
			sortOrder: Date.now() % 1_000_000_000
		})
		.returning()
		.get();

	// The first item image becomes the cover automatically
	if (itemId) {
		const item = db().select().from(schema.items).where(eq(schema.items.id, itemId)).get();
		if (item && !item.coverImageId) {
			db().update(schema.items).set({ coverImageId: img.id }).where(eq(schema.items.id, itemId)).run();
		}
	}
	return img;
}

/** Collects image inputs from a form: `<prefix>files` (multiple), `<prefix>url`, `<prefix>link_only`. */
export function imageSourcesFromForm(form: FormData, prefix = ''): ImageSource[] {
	const out: ImageSource[] = [];
	for (const entry of form.getAll(`${prefix}files`)) {
		if (entry instanceof File && entry.size > 0) out.push({ type: 'file', file: entry });
	}
	const url = String(form.get(`${prefix}url`) ?? '').trim();
	if (url) out.push({ type: 'url', url, linkOnly: form.get(`${prefix}link_only`) === 'on' });
	return out;
}

export function getOwnedImage(userId: number, imageId: number) {
	const img = db()
		.select()
		.from(schema.images)
		.where(and(eq(schema.images.id, imageId), eq(schema.images.userId, userId)))
		.get();
	if (!img) error(404, 'Image not found');
	return img;
}

export async function deleteImage(userId: number, imageId: number) {
	const img = getOwnedImage(userId, imageId);
	db().delete(schema.images).where(eq(schema.images.id, imageId)).run();
	if (img.itemId) {
		const item = db().select().from(schema.items).where(eq(schema.items.id, img.itemId)).get();
		if (item?.coverImageId === imageId) {
			const next = db()
				.select({ id: schema.images.id })
				.from(schema.images)
				.where(eq(schema.images.itemId, img.itemId))
				.orderBy(asc(schema.images.sortOrder))
				.get();
			db()
				.update(schema.items)
				.set({ coverImageId: next?.id ?? null })
				.where(eq(schema.items.id, img.itemId))
				.run();
		}
	}
	await deleteStoredFiles(img);
}

export function setCover(userId: number, itemId: number, imageId: number) {
	getOwnedItem(userId, itemId);
	const img = getOwnedImage(userId, imageId);
	if (img.itemId !== itemId) error(400, 'That image belongs to another item');
	db().update(schema.items).set({ coverImageId: imageId }).where(eq(schema.items.id, itemId)).run();
}

// --- Logs ---------------------------------------------------------------------------

export interface LogInput {
	date: string;
	rating?: number | null;
	notes?: string | null;
	location?: string | null;
	price?: number | null;
	custom?: Record<string, unknown>;
	external?: Record<string, unknown> | null;
}

export function getOwnedLog(userId: number, logId: number) {
	const log = db()
		.select()
		.from(schema.itemLogs)
		.where(and(eq(schema.itemLogs.id, logId), eq(schema.itemLogs.userId, userId)))
		.get();
	if (!log) error(404, 'Log not found');
	return log;
}

/** First status in the "done" group, used to auto-advance planned items when they get logged. */
export function firstDoneStatus(statuses: StatusDef[]) {
	return statuses.find((s) => s.group === 'done')?.key ?? null;
}

export interface LogOptions {
	/** Move a planned item to the first "done" status (off for episode check-ins, which set it themselves) */
	promote?: boolean;
	/** Runs in the same transaction as the log write (e.g. saving which episode the log is for) */
	withLog?: (logId: number) => void;
}

export function addLog(
	userId: number,
	itemId: number,
	input: LogInput,
	statuses: StatusDef[],
	{ promote = true, withLog }: LogOptions = {}
) {
	const item = getOwnedItem(userId, itemId);
	const log = db().transaction(() => {
		const row = db()
			.insert(schema.itemLogs)
			.values({
				itemId,
				userId,
				date: input.date,
				rating: input.rating ?? null,
				notes: input.notes || null,
				location: input.location || null,
				price: input.price ?? null,
				custom: input.custom ?? {},
				external: input.external ?? null
			})
			.returning()
			.get();
		withLog?.(row.id);
		return row;
	});

	const patch: Partial<Item> = { updatedAt: new Date() };
	const group = statuses.find((s) => s.key === item.status)?.group;
	if (promote && (!item.status || group === 'planned')) {
		const done = firstDoneStatus(statuses);
		if (done) patch.status = done;
	}
	db().update(schema.items).set(patch).where(eq(schema.items.id, itemId)).run();
	refreshLastLogged(itemId);
	reindexItem(itemId);
	return log;
}

export function updateLog(
	userId: number,
	logId: number,
	input: LogInput,
	{ withLog }: Pick<LogOptions, 'withLog'> = {}
) {
	const log = getOwnedLog(userId, logId);
	db().transaction(() => {
		db()
			.update(schema.itemLogs)
			.set({
				date: input.date,
				rating: input.rating ?? null,
				notes: input.notes || null,
				location: input.location || null,
				price: input.price ?? null,
				custom: input.custom ?? {},
				...(input.external !== undefined ? { external: input.external } : {})
			})
			.where(eq(schema.itemLogs.id, logId))
			.run();
		withLog?.(logId);
	});
	refreshLastLogged(log.itemId);
	reindexItem(log.itemId);
	return log;
}

export async function deleteLog(userId: number, logId: number) {
	const log = getOwnedLog(userId, logId);
	const imgs = db().select().from(schema.images).where(eq(schema.images.logId, logId)).all();
	db().delete(schema.itemLogs).where(eq(schema.itemLogs.id, logId)).run();
	for (const img of imgs) await deleteStoredFiles(img);
	refreshLastLogged(log.itemId);
	reindexItem(log.itemId);
	return log;
}

/** `[count, first, last, title]` of the episodes a log is for, read with parseLogEpisodes */
export const logEpisodesSql = (log: string) =>
	`(SELECT json_array(COUNT(*), MIN(w.season * ${EPISODE_ORDER} + w.episode),
		MAX(w.season * ${EPISODE_ORDER} + w.episode), MAX(w.title)) FROM episode_watches w WHERE w.log_id = ${log}.id)`;

export function refreshLastLogged(itemId: number) {
	rawDb()
		.prepare(
			'UPDATE items SET last_logged_at = (SELECT MAX(date) FROM item_logs WHERE item_id = ?) WHERE id = ?'
		)
		.run(itemId, itemId);
}

// --- Lists ----------------------------------------------------------------------------

export interface ListFilters {
	status?: string | null;
	group?: string | null;
	tag?: string | null;
	minRating?: number | null;
	favorite?: boolean;
	q?: string | null;
	field?: { key: string; value: string; multi: boolean } | null;
	sort?: 'recent' | 'logged' | 'rating' | 'title' | 'added';
	page?: number;
	pageSize?: number;
}

export function listItems(userId: number, categoryId: number, statuses: StatusDef[], f: ListFilters) {
	const where: string[] = ['i.user_id = ?', 'i.category_id = ?'];
	const params: unknown[] = [userId, categoryId];

	if (f.status) {
		where.push('i.status = ?');
		params.push(f.status);
	} else if (f.group) {
		const keys = statuses.filter((s) => s.group === f.group).map((s) => s.key);
		if (!keys.length) return { rows: [], total: 0 };
		where.push(`i.status IN (${keys.map(() => '?').join(',')})`);
		params.push(...keys);
	}
	if (f.tag) {
		where.push(
			'EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name = ?)'
		);
		params.push(f.tag);
	}
	if (f.minRating !== null && f.minRating !== undefined) {
		where.push('i.rating >= ?');
		params.push(f.minRating);
	}
	if (f.favorite) where.push('i.favorite = 1');
	if (f.q) {
		where.push('(i.title LIKE ? OR i.subtitle LIKE ?)');
		params.push(`%${f.q}%`, `%${f.q}%`);
	}
	if (f.field && /^[a-z0-9_]+$/.test(f.field.key)) {
		const pathExpr = `'$.${f.field.key}'`;
		if (f.field.multi) {
			where.push(`EXISTS (SELECT 1 FROM json_each(i.custom, ${pathExpr}) j WHERE j.value = ?)`);
		} else {
			where.push(`json_extract(i.custom, ${pathExpr}) = ?`);
		}
		params.push(f.field.value);
	}

	const order = {
		recent: 'i.updated_at DESC',
		logged: 'i.last_logged_at IS NULL, i.last_logged_at DESC, i.updated_at DESC',
		rating: 'i.rating IS NULL, i.rating DESC, i.title COLLATE NOCASE',
		title: 'i.title COLLATE NOCASE ASC',
		added: 'i.created_at DESC'
	}[f.sort ?? 'recent'];

	const pageSize = f.pageSize ?? 60;
	const page = Math.max(1, f.page ?? 1);
	const sqlite = rawDb();
	const total = (
		sqlite.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${where.join(' AND ')}`).get(...params) as {
			n: number;
		}
	).n;
	const rows = sqlite
		.prepare(
			`SELECT i.id, i.title, i.subtitle, i.status, i.rating, i.favorite, i.custom, i.last_logged_at,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source,
				(SELECT COUNT(*) FROM item_logs l WHERE l.item_id = i.id) AS log_count,
				-- Shows linked to TMDB: the furthest episode watched is their progress
				CASE WHEN i.provider = 'tmdb' AND i.provider_kind = 'tv' THEN
					(SELECT w.season * ${EPISODE_ORDER} + w.episode FROM episode_watches w
					 WHERE w.item_id = i.id AND w.season > 0 ORDER BY w.season DESC, w.episode DESC LIMIT 1)
				END AS furthest
			 FROM items i LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE ${where.join(' AND ')}
			 ORDER BY ${order}
			 LIMIT ? OFFSET ?`
		)
		.all(...params, pageSize, (page - 1) * pageSize) as ListRow[];
	return { rows: rows.map(mapListRow), total };
}

interface ListRow {
	id: number;
	title: string;
	subtitle: string | null;
	status: string | null;
	rating: number | null;
	favorite: number;
	custom: string;
	last_logged_at: string | null;
	img_kind: Image['kind'] | null;
	img_path: string | null;
	img_thumb: string | null;
	img_source: string | null;
	log_count: number;
	furthest: number | null;
}

function mapListRow(r: ListRow) {
	let custom: Record<string, unknown> = {};
	try {
		custom = JSON.parse(r.custom);
	} catch {
		/* keep empty */
	}
	if (r.furthest !== null) {
		custom.current_season = Math.floor(r.furthest / EPISODE_ORDER);
		custom.current_episode = r.furthest % EPISODE_ORDER;
	}
	return {
		id: r.id,
		title: r.title,
		subtitle: r.subtitle,
		status: r.status,
		rating: r.rating,
		favorite: !!r.favorite,
		custom,
		lastLoggedAt: r.last_logged_at,
		logCount: r.log_count,
		image: r.img_kind
			? { kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source }
			: null
	};
}

export type ListItem = ReturnType<typeof mapListRow>;

// --- Dashboard ------------------------------------------------------------------------

export function recentActivity(userId: number, limit = 15) {
	return rawDb()
		.prepare(
			`SELECT l.id AS log_id, l.date, l.rating AS log_rating, l.notes, l.location, ${logEpisodesSql('l')} AS ep,
				i.id AS item_id, i.title, c.name AS category_name, c.icon AS category_icon,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM item_logs l
			 JOIN items i ON i.id = l.item_id
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE l.user_id = ?
			 ORDER BY l.date DESC, l.id DESC
			 LIMIT ?`
		)
		.all(userId, limit) as {
		log_id: number;
		date: string;
		log_rating: number | null;
		notes: string | null;
		location: string | null;
		ep: string;
		item_id: number;
		title: string;
		category_name: string;
		category_icon: string;
		img_kind: Image['kind'] | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];
}

/**
 * Items in a "planned" status (from lists that show them in Up next) or favorites, newest first.
 */
export function itemStrip(userId: number, kind: 'planned' | 'favorites', limit = 12) {
	const rows = rawDb()
		.prepare(
			`SELECT i.id, i.title, i.status, c.statuses, c.icon AS category_icon, c.name AS category_name,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM items i
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE i.user_id = ? ${kind === 'favorites' ? 'AND i.favorite = 1' : 'AND c.show_up_next = 1'}
			 ORDER BY i.updated_at DESC
			 LIMIT 300`
		)
		.all(userId) as {
		id: number;
		title: string;
		status: string | null;
		statuses: string;
		category_icon: string;
		category_name: string;
		img_kind: Image['kind'] | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}[];
	const filtered =
		kind === 'planned'
			? rows.filter((r) => {
					try {
						const st = JSON.parse(r.statuses) as StatusDef[];
						return st.find((s) => s.key === r.status)?.group === 'planned';
					} catch {
						return false;
					}
				})
			: rows;
	return filtered.slice(0, limit);
}
