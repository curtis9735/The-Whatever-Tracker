import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db, rawDb, schema } from '../db';
import { reindexItem } from '../search/local';
import { deleteStoredFiles, storeImageFromUrl, storeUploadedFile, type StoredImage } from '../images/store';
import { getCategoryById } from './categories';
import {
	listAccess,
	ME,
	MINE_UP_NEXT,
	MINE_UPDATED,
	mine,
	PROGRESS_JOIN,
	requireAccess,
	SEES_LIST,
	SHARE_JOIN,
	seesList
} from './access';
import type { Image, Item } from '../db/schema';
import type { ListAccess, StatusDef } from '$lib/types';
import {
	EPISODE_ORDER,
	ownersProgressFields,
	parseLogEpisodes,
	PROGRESS_KEYS,
	type LogEpisodes
} from '$lib/episodes';

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

/** Each person's own: kept on the item for the list's owner, in item_progress for everyone else */
const PERSONAL = ['status', 'rating', 'favorite', 'notes'] as const;
export type Progress = Partial<Pick<Item, (typeof PERSONAL)[number]>>;

/**
 * An item as the viewer sees it: the status, rating, favorite, notes and last logged date are theirs
 * (on a list shared with them, never the owner's). `userId` is the list owner's; `access` the viewer's.
 */
export type ViewItem = Item & { access: ListAccess };

/**
 * The item, if its list is the viewer's or shared with them. `need`: 'view' for reading and for the
 * viewer's own progress (status, rating, logs…), 'edit' to change the item itself.
 */
export function getItem(userId: number, itemId: number, need: ListAccess = 'view'): ViewItem {
	const item = db().select().from(schema.items).where(eq(schema.items.id, itemId)).get();
	const access = item ? listAccess(userId, item.categoryId) : null;
	requireAccess(access, need, 'Item not found');
	if (item!.userId === userId) return { ...item!, access: access! };
	const p = db()
		.select()
		.from(schema.itemProgress)
		.where(and(eq(schema.itemProgress.itemId, itemId), eq(schema.itemProgress.userId, userId)))
		.get();
	return {
		...item!,
		status: p?.status ?? null,
		rating: p?.rating ?? null,
		favorite: p?.favorite ?? false,
		notes: p?.notes ?? null,
		lastLoggedAt: p?.lastLoggedAt ?? null,
		access: access!
	};
}

/** Saves the viewer's own status, rating, favorite or notes, and marks the item as just changed for them */
export function setProgress(userId: number, item: Pick<Item, 'id' | 'userId'>, patch: Progress) {
	const updatedAt = new Date();
	if (item.userId === userId) {
		db()
			.update(schema.items)
			.set({ ...patch, updatedAt })
			.where(eq(schema.items.id, item.id))
			.run();
		return;
	}
	db()
		.insert(schema.itemProgress)
		.values({ itemId: item.id, userId, ...patch, updatedAt })
		.onConflictDoUpdate({
			target: [schema.itemProgress.itemId, schema.itemProgress.userId],
			set: { ...patch, updatedAt }
		})
		.run();
}

function splitPatch(patch: Partial<ItemInput>) {
	const personal: Progress = {};
	const shared: Partial<ItemInput> = {};
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if ((PERSONAL as readonly string[]).includes(k)) (personal as Record<string, unknown>)[k] = v;
		else (shared as Record<string, unknown>)[k] = v;
	}
	return { personal, shared };
}

/** Whether a submitted value is what the item already has (an empty text counts as no value) */
function sameValue(a: unknown, b: unknown) {
	const plain = (v: unknown): string =>
		JSON.stringify(v === '' || v === undefined ? null : v, (_k, x) =>
			x && typeof x === 'object' && !Array.isArray(x)
				? Object.fromEntries(Object.entries(x).sort(([m], [n]) => (m < n ? -1 : m > n ? 1 : 0)))
				: x
		);
	return plain(a) === plain(b);
}

/**
 * A show's saved "Current season / episode" is its owner's progress (they become the owner's watched
 * episodes once the show is linked to TMDB), so only the owner sets them: anyone else's values are
 * dropped and the owner's kept.
 */
function keepOwnersProgress(custom: Record<string, unknown>, current: Record<string, unknown> = {}) {
	const out = { ...custom };
	for (const k of PROGRESS_KEYS) {
		if (k in current) out[k] = current[k];
		else delete out[k];
	}
	return out;
}

/**
 * A status in another list: the same one if it has it, otherwise its first status in the same group
 * (Watching → Playing), or its first status.
 */
export function statusInList(key: string | null, from: StatusDef[], to: StatusDef[]) {
	if (!key || to.some((s) => s.key === key)) return key;
	const group = from.find((s) => s.key === key)?.group;
	return to.find((s) => s.group === group)?.key ?? to[0]?.key ?? null;
}

/**
 * After an item moves to a list with other statuses, everyone's status the new list doesn't have
 * becomes its closest one (statusInList). `skipUserId` is the mover when they picked their own status.
 */
function remapStatuses(
	item: Pick<Item, 'id' | 'userId'>,
	from: StatusDef[],
	to: StatusDef[],
	skipUserId: number | null
) {
	const keys = new Set(to.map((s) => s.key));
	const remap = (key: string) => statusInList(key, from, to);
	const sqlite = rawDb();
	if (skipUserId !== item.userId) {
		const own = sqlite.prepare('SELECT status FROM items WHERE id = ?').get(item.id) as {
			status: string | null;
		};
		if (own.status && !keys.has(own.status)) {
			sqlite.prepare('UPDATE items SET status = ? WHERE id = ?').run(remap(own.status), item.id);
		}
	}
	const rows = sqlite
		.prepare('SELECT user_id AS userId, status FROM item_progress WHERE item_id = ? AND status IS NOT NULL')
		.all(item.id) as { userId: number; status: string }[];
	const set = sqlite.prepare('UPDATE item_progress SET status = ? WHERE item_id = ? AND user_id = ?');
	for (const r of rows) {
		if (r.userId !== skipUserId && !keys.has(r.status)) set.run(remap(r.status), item.id, r.userId);
	}
}

export function createItem(userId: number, input: ItemInput, tagNames: string[] = []): ViewItem {
	// 404 if the list isn't the viewer's, 403 if it's shared with them only to view
	const { category } = getCategoryById(userId, input.categoryId, 'edit');
	// Items belong to the list's owner; someone else adding one keeps their own status and rating
	const ownerId = category.userId;
	const theirs = ownerId === userId;
	const now = new Date();
	const item = db()
		.insert(schema.items)
		.values({
			userId: ownerId,
			categoryId: input.categoryId,
			title: input.title,
			subtitle: input.subtitle || null,
			description: input.description || null,
			status: theirs ? input.status || null : null,
			rating: theirs ? (input.rating ?? null) : null,
			favorite: theirs ? (input.favorite ?? false) : false,
			barcode: input.barcode || null,
			notes: theirs ? input.notes || null : null,
			custom:
				theirs || !ownersProgressFields(input, category.providerKinds)
					? (input.custom ?? {})
					: keepOwnersProgress(input.custom ?? {}),
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
	if (!theirs) {
		setProgress(userId, item, {
			status: input.status || null,
			rating: input.rating ?? null,
			favorite: input.favorite ?? false,
			notes: input.notes || null
		});
	}
	setTags(ownerId, item.id, tagNames);
	return getItem(userId, item.id);
}

/**
 * Status, rating, favorite and notes are the viewer's own (anyone the list is shared with can change
 * theirs); anything else, tags included, changes the item for everyone and needs edit access.
 */
export function updateItem(userId: number, itemId: number, patch: Partial<ItemInput>, tagNames?: string[]) {
	const item = getItem(userId, itemId);
	const { personal, shared } = splitPatch(patch);
	if (Object.keys(shared).length || tagNames) requireAccess(item.access, 'edit', 'Item not found');
	const current = getCategoryById(userId, item.categoryId).category;
	let move: { from: StatusDef[]; to: StatusDef[] } | null = null;
	let listKinds = current.providerKinds;
	if (shared.categoryId !== undefined && shared.categoryId !== item.categoryId) {
		const target = getCategoryById(userId, shared.categoryId, 'edit').category;
		listKinds = [...listKinds, ...target.providerKinds];
		// Everyone's progress stays with the item, so it only moves between one owner's lists
		if (target.userId !== item.userId) error(400, 'An item can only move to another list of the same owner.');
		// …and the people it's shared with might not have the other list, so only its owner moves what they've tracked
		if (item.userId !== userId && othersTracked(item.id, userId)) {
			error(403, 'Others have tracked this, so only the list’s owner can move it to another list.');
		}
		move = { from: current.statuses, to: target.statuses };
		// A status the new list doesn't have (the form's status menu went blank) isn't a choice: it's remapped below
		if (personal.status !== undefined && !target.statuses.some((s) => s.key === personal.status)) {
			delete personal.status;
		}
	}
	if (item.userId !== userId) {
		if (shared.custom && ownersProgressFields({ ...item, ...shared }, listKinds)) {
			shared.custom = keepOwnersProgress(shared.custom, item.custom);
		}
		// The edit form sends every field: only real changes count as an edit (and move the owner's "recent")
		for (const k of Object.keys(shared) as (keyof typeof shared)[]) {
			if (sameValue(shared[k], item[k as keyof Item])) delete shared[k];
		}
	}
	if (item.userId === userId) {
		db()
			.update(schema.items)
			.set({ ...shared, ...personal, updatedAt: new Date() })
			.where(eq(schema.items.id, itemId))
			.run();
	} else {
		if (Object.keys(shared).length) {
			db()
				.update(schema.items)
				.set({ ...shared, updatedAt: new Date() })
				.where(eq(schema.items.id, itemId))
				.run();
		}
		if (Object.keys(personal).length) setProgress(userId, item, personal);
	}
	if (move) remapStatuses(item, move.from, move.to, personal.status !== undefined ? userId : null);
	if (tagNames) setTags(item.userId, itemId, tagNames);
	else reindexItem(itemId);
}

/** Whether anyone but `userId` has tracked the item: a status, rating, note, favorite, log or episode */
function othersTracked(itemId: number, userId: number) {
	return !!rawDb()
		.prepare(
			`SELECT 1 FROM items i WHERE i.id = @item AND (
				(i.user_id != @user AND (i.status IS NOT NULL OR i.rating IS NOT NULL OR i.favorite = 1 OR i.notes IS NOT NULL))
				OR EXISTS (SELECT 1 FROM item_logs WHERE item_id = @item AND user_id != @user)
				OR EXISTS (SELECT 1 FROM episode_watches WHERE item_id = @item AND user_id != @user)
				OR EXISTS (SELECT 1 FROM item_progress WHERE item_id = @item AND user_id != @user
					AND (status IS NOT NULL OR rating IS NOT NULL OR favorite = 1 OR notes IS NOT NULL)))`
		)
		.get({ item: itemId, user: userId });
}

/**
 * Whether the viewer may delete the item: always on their own list; on a list shared with them to
 * edit, only while nobody else has tracked it, so nobody loses their history.
 */
export function canDeleteItem(userId: number, item: ViewItem) {
	if (item.userId === userId) return true;
	return item.access === 'edit' && !othersTracked(item.id, userId);
}

export async function deleteItem(userId: number, itemId: number) {
	const item = getItem(userId, itemId, 'edit');
	if (!canDeleteItem(userId, item)) {
		error(403, 'Others have tracked this, so only the list’s owner can delete it.');
	}
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

/** Tags belong to the list's owner (`ownerId`), like its items */
export function setTags(ownerId: number, itemId: number, names: string[]) {
	db().transaction(() => {
		db().delete(schema.itemTags).where(eq(schema.itemTags.itemId, itemId)).run();
		for (const name of names) {
			db().insert(schema.tags).values({ userId: ownerId, name }).onConflictDoNothing().run();
			const tag = db()
				.select({ id: schema.tags.id })
				.from(schema.tags)
				.where(and(eq(schema.tags.userId, ownerId), eq(schema.tags.name, name)))
				.get();
			if (tag) db().insert(schema.itemTags).values({ itemId, tagId: tag.id }).onConflictDoNothing().run();
		}
		// Drop tags nobody uses any more
		db()
			.delete(schema.tags)
			.where(
				and(
					eq(schema.tags.userId, ownerId),
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

/** Tag suggestions: pass the list owner's id (tags belong to the owner of the list an item is on) */
export function listUserTags(userId: number) {
	return db()
		.select({ name: schema.tags.name })
		.from(schema.tags)
		.where(eq(schema.tags.userId, userId))
		.orderBy(asc(schema.tags.name))
		.all()
		.map((t) => t.name);
}

/**
 * Tag suggestions for an item on `ownerId`'s list: all of the owner's tags for the owner; for anyone
 * else only tags used on lists they can see (the owner's other lists stay private).
 */
export function tagSuggestions(viewerId: number, ownerId: number) {
	if (viewerId === ownerId) return listUserTags(ownerId);
	return (
		rawDb()
			.prepare(
				`SELECT DISTINCT t.name FROM ${ME} CROSS JOIN tags t
				 JOIN item_tags it ON it.tag_id = t.id JOIN items i ON i.id = it.item_id
				 JOIN categories c ON c.id = i.category_id
				 WHERE t.user_id = ? AND ${seesList()} ORDER BY t.name`
			)
			.all(viewerId, ownerId) as { name: string }[]
	).map((t) => t.name);
}

/** The item page: the item with the viewer's progress, their own logs, and everyone else's progress */
export function getItemDetail(userId: number, itemId: number) {
	const item = getItem(userId, itemId);
	const cat = getCategoryById(userId, item.categoryId);
	const logs = db()
		.select()
		.from(schema.itemLogs)
		.where(and(eq(schema.itemLogs.itemId, itemId), eq(schema.itemLogs.userId, userId)))
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
					 WHERE l.item_id = ? AND l.user_id = ? AND EXISTS (SELECT 1 FROM episode_watches w WHERE w.log_id = l.id)`
				)
				.all(itemId, userId) as { id: number; ep: string }[]
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
		})),
		household: householdProgress(userId, item),
		canDelete: canDeleteItem(userId, item)
	};
}

export interface HouseholdLog {
	id: number;
	date: string;
	rating: number | null;
	notes: string | null;
	location: string | null;
	custom: Record<string, unknown>;
	episodes: LogEpisodes | null;
}

/** Someone else's progress on an item of a shared list */
export interface HouseholdProgress {
	userId: number;
	name: string;
	/** The list is theirs */
	owner: boolean;
	status: string | null;
	rating: number | null;
	favorite: boolean;
	notes: string | null;
	lastLoggedAt: string | null;
	/** Their latest logs, newest first (at most 50) */
	logs: HouseholdLog[];
	logCount: number;
	/** Shows linked to TMDB: how many episodes they've watched, and the furthest one */
	episodesWatched: number;
	furthest: { season: number; episode: number } | null;
}

/** Everyone else who has the item's list (its owner, and who it's shared with) and has tracked the item */
export function householdProgress(viewerId: number, item: Pick<Item, 'id' | 'userId' | 'categoryId'>) {
	const sqlite = rawDb();
	const people = sqlite
		.prepare(
			`SELECT u.id AS userId, u.display_name AS name, u.id = @owner AS owner,
				IIF(u.id = @owner, i.status, p.status) AS status, IIF(u.id = @owner, i.rating, p.rating) AS rating,
				IIF(u.id = @owner, i.favorite, COALESCE(p.favorite, 0)) AS favorite,
				IIF(u.id = @owner, i.notes, p.notes) AS notes,
				IIF(u.id = @owner, i.last_logged_at, p.last_logged_at) AS lastLoggedAt
			 FROM users u JOIN items i ON i.id = @item
			 LEFT JOIN item_progress p ON p.item_id = i.id AND p.user_id = u.id
			 WHERE u.id != @viewer AND (u.id = @owner OR u.id IN (SELECT user_id FROM list_shares WHERE category_id = @list))
			 ORDER BY u.id != @owner, u.display_name COLLATE NOCASE`
		)
		.all({ owner: item.userId, item: item.id, viewer: viewerId, list: item.categoryId }) as (Omit<
		HouseholdProgress,
		'logs' | 'logCount' | 'episodesWatched' | 'furthest' | 'owner' | 'favorite'
	> & { owner: number; favorite: number })[];
	const logsOf = sqlite.prepare(
		`SELECT l.id, l.date, l.rating, l.notes, l.location, l.custom, ${logEpisodesSql('l')} AS ep
		 FROM item_logs l WHERE l.item_id = ? AND l.user_id = ? ORDER BY l.date DESC, l.id DESC LIMIT 50`
	);
	const logCount = sqlite.prepare('SELECT COUNT(*) AS n FROM item_logs WHERE item_id = ? AND user_id = ?');
	const watched = sqlite.prepare(
		`SELECT COUNT(DISTINCT season * ${EPISODE_ORDER} + episode) AS n, MAX(season * ${EPISODE_ORDER} + episode) AS furthest
		 FROM episode_watches WHERE item_id = ? AND user_id = ? AND season > 0`
	);
	const out: HouseholdProgress[] = [];
	for (const p of people) {
		const logs = (
			logsOf.all(item.id, p.userId) as (Omit<HouseholdLog, 'custom' | 'episodes'> & {
				custom: string;
				ep: string;
			})[]
		).map(({ custom, ep, ...l }) => ({ ...l, custom: parseJson(custom), episodes: parseLogEpisodes(ep) }));
		const w = watched.get(item.id, p.userId) as { n: number; furthest: number | null };
		const tracked = p.status || p.rating !== null || p.favorite || p.notes || logs.length || w.n;
		if (!tracked) continue;
		out.push({
			...p,
			owner: !!p.owner,
			favorite: !!p.favorite,
			logs,
			logCount: (logCount.get(item.id, p.userId) as { n: number }).n,
			episodesWatched: w.n,
			furthest:
				w.furthest === null
					? null
					: { season: Math.floor(w.furthest / EPISODE_ORDER), episode: w.furthest % EPISODE_ORDER }
		});
	}
	return out;
}

function parseJson(s: string | null): Record<string, unknown> {
	try {
		return s ? JSON.parse(s) : {};
	} catch {
		return {};
	}
}

// --- Images -------------------------------------------------------------------------

export type ImageSource = { type: 'file'; file: File } | { type: 'url'; url: string; linkOnly: boolean };

/**
 * Item photos belong to the list's owner (and are stored in their folder), whoever adds them; adding
 * one needs edit access. Log photos belong to whoever wrote the log.
 */
export async function addImage(
	userId: number,
	target: { itemId: number } | { logId: number },
	source: ImageSource
): Promise<Image> {
	const ownerId =
		'itemId' in target
			? getItem(userId, target.itemId, 'edit').userId
			: getOwnedLog(userId, target.logId).userId;
	let stored: StoredImage | null = null;
	let kind: Image['kind'];
	let sourceUrl: string | null = null;

	if (source.type === 'file') {
		stored = await storeUploadedFile(ownerId, source.file);
		kind = 'upload';
	} else if (source.linkOnly) {
		const url = source.url.trim();
		if (!/^https?:\/\//i.test(url)) throw new Error('Image links must start with http:// or https://');
		kind = 'url_link';
		sourceUrl = url;
	} else {
		stored = await storeImageFromUrl(ownerId, source.url.trim());
		kind = 'url_copy';
		sourceUrl = source.url.trim();
	}

	const itemId = 'itemId' in target ? target.itemId : null;
	const logId = 'logId' in target ? target.logId : null;
	const img = db()
		.insert(schema.images)
		.values({
			userId: ownerId,
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

/** A photo the viewer may change: on an item they can edit, or on one of their own logs */
export function getEditableImage(userId: number, imageId: number) {
	const img = db().select().from(schema.images).where(eq(schema.images.id, imageId)).get();
	if (!img) error(404, 'Image not found');
	if (img.logId !== null) getOwnedLog(userId, img.logId);
	else if (img.itemId !== null) getItem(userId, img.itemId, 'edit');
	else error(404, 'Image not found');
	return img;
}

export async function deleteImage(userId: number, imageId: number) {
	const img = getEditableImage(userId, imageId);
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
	getItem(userId, itemId, 'edit');
	const img = getEditableImage(userId, imageId);
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

/** One of the viewer's own logs, while its item's list is still theirs or shared with them */
export function getOwnedLog(userId: number, logId: number) {
	const log = db()
		.select()
		.from(schema.itemLogs)
		.where(and(eq(schema.itemLogs.id, logId), eq(schema.itemLogs.userId, userId)))
		.get();
	const item = log && db().select().from(schema.items).where(eq(schema.items.id, log.itemId)).get();
	if (!log || !item || !listAccess(userId, item.categoryId)) error(404, 'Log not found');
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

/** Logs are each person's own: anyone the list is shared with, even to view, keeps theirs */
export function addLog(
	userId: number,
	itemId: number,
	input: LogInput,
	statuses: StatusDef[],
	{ promote = true, withLog }: LogOptions = {}
) {
	const item = getItem(userId, itemId);
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

	const patch: Progress = {};
	const group = statuses.find((s) => s.key === item.status)?.group;
	if (promote && (!item.status || group === 'planned')) {
		const done = firstDoneStatus(statuses);
		if (done) patch.status = done;
	}
	setProgress(userId, item, patch);
	refreshLastLogged(itemId, userId);
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
	refreshLastLogged(log.itemId, userId);
	reindexItem(log.itemId);
	return log;
}

export async function deleteLog(userId: number, logId: number) {
	const log = getOwnedLog(userId, logId);
	const imgs = db().select().from(schema.images).where(eq(schema.images.logId, logId)).all();
	db().delete(schema.itemLogs).where(eq(schema.itemLogs.id, logId)).run();
	for (const img of imgs) await deleteStoredFiles(img);
	refreshLastLogged(log.itemId, userId);
	reindexItem(log.itemId);
	return log;
}

/** `[count, first, last, title]` of the episodes a log is for, read with parseLogEpisodes */
export const logEpisodesSql = (log: string) =>
	`(SELECT json_array(COUNT(*), MIN(w.season * ${EPISODE_ORDER} + w.episode),
		MAX(w.season * ${EPISODE_ORDER} + w.episode), MAX(w.title)) FROM episode_watches w WHERE w.log_id = ${log}.id)`;

/** The date of someone's latest log of an item, kept with their progress */
export function refreshLastLogged(itemId: number, userId: number) {
	const sqlite = rawDb();
	const item = sqlite.prepare('SELECT user_id AS ownerId FROM items WHERE id = ?').get(itemId) as
		{ ownerId: number } | undefined;
	if (!item) return;
	const last = (
		sqlite
			.prepare('SELECT MAX(date) AS d FROM item_logs WHERE item_id = ? AND user_id = ?')
			.get(itemId, userId) as {
			d: string | null;
		}
	).d;
	if (item.ownerId === userId) {
		sqlite.prepare('UPDATE items SET last_logged_at = ? WHERE id = ?').run(last, itemId);
		return;
	}
	const r = sqlite
		.prepare('UPDATE item_progress SET last_logged_at = ? WHERE item_id = ? AND user_id = ?')
		.run(last, itemId, userId);
	if (!r.changes && last) {
		sqlite
			.prepare('INSERT INTO item_progress (item_id, user_id, last_logged_at, updated_at) VALUES (?, ?, ?, ?)')
			.run(itemId, userId, last, Date.now());
	}
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

/** A list's items with the viewer's own progress (none when the list isn't theirs or shared with them) */
export function listItems(userId: number, categoryId: number, statuses: StatusDef[], f: ListFilters) {
	const where: string[] = ['i.category_id = ?', seesList()];
	const params: unknown[] = [categoryId];
	const status = mine('status');
	const rating = mine('rating');
	const logged = mine('last_logged_at');

	if (f.status) {
		where.push(`${status} = ?`);
		params.push(f.status);
	} else if (f.group) {
		const keys = statuses.filter((s) => s.group === f.group).map((s) => s.key);
		if (!keys.length) return { rows: [], total: 0 };
		where.push(`${status} IN (${keys.map(() => '?').join(',')})`);
		params.push(...keys);
	}
	if (f.tag) {
		where.push(
			'EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name = ?)'
		);
		params.push(f.tag);
	}
	if (f.minRating !== null && f.minRating !== undefined) {
		where.push(`${rating} >= ?`);
		params.push(f.minRating);
	}
	if (f.favorite) where.push(`${mine('favorite')} = 1`);
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
		recent: `${MINE_UPDATED} DESC`,
		logged: `${logged} IS NULL, ${logged} DESC, ${MINE_UPDATED} DESC`,
		rating: `${rating} IS NULL, ${rating} DESC, i.title COLLATE NOCASE`,
		title: 'i.title COLLATE NOCASE ASC',
		added: 'i.created_at DESC'
	}[f.sort ?? 'recent'];

	const pageSize = f.pageSize ?? 60;
	const page = Math.max(1, f.page ?? 1);
	const sqlite = rawDb();
	const from = `FROM ${ME} CROSS JOIN items i JOIN categories c ON c.id = i.category_id ${PROGRESS_JOIN}`;
	const total = (
		sqlite.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`).get(userId, ...params) as {
			n: number;
		}
	).n;
	const rows = sqlite
		.prepare(
			`SELECT i.id, i.title, i.subtitle, ${status} AS status, ${rating} AS rating, i.user_id = me.id AS mine, i.provider, i.provider_kind AS providerKind,
				${mine('favorite')} AS favorite, i.custom, ${logged} AS last_logged_at,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source,
				(SELECT COUNT(*) FROM item_logs l WHERE l.item_id = i.id AND l.user_id = me.id) AS log_count,
				-- Shows linked to TMDB: the furthest episode the viewer has watched is their progress
				CASE WHEN i.provider = 'tmdb' AND i.provider_kind = 'tv' THEN
					(SELECT w.season * ${EPISODE_ORDER} + w.episode FROM episode_watches w
					 WHERE w.item_id = i.id AND w.user_id = me.id AND w.season > 0
					 ORDER BY w.season DESC, w.episode DESC LIMIT 1)
				END AS furthest
			 ${from} LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE ${where.join(' AND ')}
			 ORDER BY ${order}
			 LIMIT ? OFFSET ?`
		)
		.all(userId, ...params, pageSize, (page - 1) * pageSize) as ListRow[];
	const kinds = rawDb().prepare('SELECT provider_kinds AS k FROM categories WHERE id = ?').get(categoryId) as
		{ k: string } | undefined;
	const listKinds = JSON.parse(kinds?.k ?? '[]') as string[];
	return { rows: rows.map((r) => mapListRow(r, listKinds)), total };
}

/** How many of a list's items the viewer has in each status ('' for none) */
export function statusCounts(userId: number, categoryId: number): Record<string, number> {
	const rows = rawDb()
		.prepare(
			`SELECT ${mine('status')} AS status, COUNT(*) AS n FROM ${ME} CROSS JOIN items i
			 JOIN categories c ON c.id = i.category_id ${PROGRESS_JOIN}
			 WHERE i.category_id = ? AND ${seesList()} GROUP BY 1`
		)
		.all(userId, categoryId) as { status: string | null; n: number }[];
	return Object.fromEntries(rows.map((c) => [c.status ?? '', c.n]));
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
	mine: number;
	provider: string | null;
	providerKind: string | null;
}

function mapListRow(r: ListRow, listKinds: string[]) {
	let custom: Record<string, unknown> = {};
	try {
		custom = JSON.parse(r.custom);
	} catch {
		/* keep empty */
	}
	// A show's saved current season/episode is the owner's progress, not the viewer's
	if (!r.mine && ownersProgressFields(r, listKinds)) for (const k of PROGRESS_KEYS) delete custom[k];
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

/** The viewer's latest logs, on lists they still have */
export function recentActivity(userId: number, limit = 15) {
	return rawDb()
		.prepare(
			`SELECT l.id AS log_id, l.date, l.rating AS log_rating, l.notes, l.location, ${logEpisodesSql('l')} AS ep,
				i.id AS item_id, i.title, c.name AS category_name, c.icon AS category_icon,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM ${ME} CROSS JOIN item_logs l
			 JOIN items i ON i.id = l.item_id
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE l.user_id = me.id AND ${seesList()}
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
 * Items the viewer has in a "planned" status (from lists they show in Up next) or as favorites,
 * newest first. On shared lists it's their own status and favorites, and their own Up next choice.
 */
export function itemStrip(userId: number, kind: 'planned' | 'favorites', limit = 12) {
	const rows = rawDb()
		.prepare(
			`SELECT i.id, i.title, ${mine('status')} AS status, c.statuses, c.icon AS category_icon, c.name AS category_name,
				im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source
			 FROM ${ME} CROSS JOIN items i
			 JOIN categories c ON c.id = i.category_id
			 ${SHARE_JOIN}
			 ${PROGRESS_JOIN}
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE ${SEES_LIST} AND ${
					kind === 'favorites'
						? `${mine('favorite')} = 1`
						: `${MINE_UP_NEXT} = 1 AND ${mine('status')} IS NOT NULL`
				}
			 ORDER BY ${MINE_UPDATED} DESC
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
