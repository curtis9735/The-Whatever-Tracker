import crypto from 'node:crypto';
import { error } from '@sveltejs/kit';
import { rawDb } from '../db';
import { isSafeRelativePath } from '../images/store';
import { listAccess, requireAccess } from './access';
import { getItemTags, localDay, logEpisodesSql } from './items';
import { logEpisodeLabel, parseLogEpisodes, progressLabel, PROGRESS_KEYS } from '$lib/episodes';
import { formatFieldValue } from '$lib/fields';
import type { FieldDef, MetadataFact, SetlistEvent, StatusDef } from '$lib/types';

/*
 * Read-only share links: a long secret URL that shows one list to people without an account.
 * Everything a visitor can reach goes through a token and is scoped to that token's list, and shows
 * the list owner's own view of it: their status, rating and notes on each item (never anyone else's
 * progress) and only the owner's logs. Nothing here writes except the link's own view counter.
 */

/** 32 random bytes as base64url */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** A link's view counter moves at most this often */
const VIEW_THROTTLE_MS = 60_000;
/** Newest logs shown on an item's page; the rest are counted */
const LOG_CAP = 50;

function notFound(): never {
	error(404, 'Not found');
}

// --- Managing a link (the list's owner) -----------------------------------------------------------

export interface ShareLinkInfo {
	token: string;
	createdAt: number;
	/** ms since the epoch, or null when it doesn't expire */
	expiresAt: number | null;
	expired: boolean;
	viewCount: number;
	lastViewedAt: number | null;
}

interface LinkRow {
	token: string;
	createdAt: number;
	expiresAt: number | null;
	viewCount: number;
	lastViewedAt: number | null;
}

const LINK_COLUMNS = `token, created_at AS createdAt, expires_at AS expiresAt, view_count AS viewCount,
	last_viewed_at AS lastViewedAt`;

function toInfo(r: LinkRow, now: number): ShareLinkInfo {
	return { ...r, expired: r.expiresAt !== null && r.expiresAt <= now };
}

function requireOwner(userId: number, categoryId: number) {
	requireAccess(listAccess(userId, categoryId), 'owner', 'Category not found');
}

/** The list's current link (turned on, even if it has expired), or null. Owner only. */
export function getShareLink(userId: number, categoryId: number, now = Date.now()): ShareLinkInfo | null {
	requireOwner(userId, categoryId);
	const row = rawDb()
		.prepare(`SELECT ${LINK_COLUMNS} FROM share_links WHERE category_id = ? AND revoked_at IS NULL`)
		.get(categoryId) as LinkRow | undefined;
	return row ? toInfo(row, now) : null;
}

/** Turns the link on, or makes a new one: the old link (if any) stops working. Owner only. */
export function createShareLink(userId: number, categoryId: number, now = Date.now()): ShareLinkInfo {
	requireOwner(userId, categoryId);
	const sqlite = rawDb();
	const token = crypto.randomBytes(32).toString('base64url');
	sqlite.transaction(() => {
		sqlite
			.prepare('UPDATE share_links SET revoked_at = ? WHERE category_id = ? AND revoked_at IS NULL')
			.run(now, categoryId);
		sqlite
			.prepare('INSERT INTO share_links (category_id, created_by, token, created_at) VALUES (?, ?, ?, ?)')
			.run(categoryId, userId, token, now);
	})();
	return getShareLink(userId, categoryId, now)!;
}

/** Turns the link off. Owner only. */
export function turnOffShareLink(userId: number, categoryId: number, now = Date.now()) {
	requireOwner(userId, categoryId);
	rawDb()
		.prepare('UPDATE share_links SET revoked_at = ? WHERE category_id = ? AND revoked_at IS NULL')
		.run(now, categoryId);
}

/** When the link stops working (ms since the epoch), or null for never. Owner only. */
export function setShareExpiry(userId: number, categoryId: number, expiresAt: number | null) {
	requireOwner(userId, categoryId);
	rawDb()
		.prepare('UPDATE share_links SET expires_at = ? WHERE category_id = ? AND revoked_at IS NULL')
		.run(expiresAt, categoryId);
}

/**
 * The expiry choice on the settings page: "none", a number of days, or "custom" with a date (the link
 * works through the end of that day). null: never expires. 'invalid': not a future date or a known choice.
 */
export function parseExpiry(choice: string, date: string, now = Date.now()): number | null | 'invalid' {
	if (choice === 'none') return null;
	if (choice === '7' || choice === '30') return now + Number(choice) * 86_400_000;
	if (choice === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
		const end = new Date(`${date}T23:59:59.999`).getTime();
		return Number.isFinite(end) && end > now ? end : 'invalid';
	}
	return 'invalid';
}

// --- Reading through a token ----------------------------------------------------------------------

interface Shared {
	linkId: number;
	token: string;
	categoryId: number;
	ownerId: number;
	ownerName: string;
	name: string;
	icon: string;
	color: string;
	statuses: StatusDef[];
	providerKinds: string[];
	itemFields: FieldDef[];
	logFields: FieldDef[];
}

/** The list a token opens, or null: unknown, revoked and expired all look the same */
function resolve(token: string, now: number): Shared | null {
	if (!TOKEN_RE.test(token)) return null;
	const sqlite = rawDb();
	const r = sqlite
		.prepare(
			`SELECT s.id AS linkId, c.id AS categoryId, c.user_id AS ownerId, u.display_name AS ownerName,
				c.name, c.icon, c.color, c.statuses, c.provider_kinds AS providerKinds
			 FROM share_links s JOIN categories c ON c.id = s.category_id JOIN users u ON u.id = c.user_id
			 WHERE s.token = ? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)`
		)
		.get(token, now) as
		| (Omit<Shared, 'token' | 'statuses' | 'providerKinds' | 'itemFields' | 'logFields'> & {
				statuses: string;
				providerKinds: string;
		  })
		| undefined;
	if (!r) return null;
	const defs = (
		sqlite
			.prepare(
				`SELECT key, label, type, scope, options, unit, show_on_card AS showOnCard FROM field_definitions
				 WHERE category_id = ? ORDER BY sort_order, id`
			)
			.all(r.categoryId) as (Omit<FieldDef, 'options' | 'showOnCard'> & {
			options: string;
			showOnCard: number;
		})[]
	).map((f): FieldDef => ({ ...f, options: JSON.parse(f.options) as string[], showOnCard: !!f.showOnCard }));
	return {
		...r,
		token,
		statuses: JSON.parse(r.statuses) as StatusDef[],
		providerKinds: JSON.parse(r.providerKinds) as string[],
		itemFields: defs.filter((f) => f.scope === 'item'),
		logFields: defs.filter((f) => f.scope === 'log')
	};
}

/** Counts a visit, at most once a minute per link */
export function recordView(linkId: number, now = Date.now()) {
	rawDb()
		.prepare(
			`UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ?
			 WHERE id = ? AND (last_viewed_at IS NULL OR last_viewed_at <= ?)`
		)
		.run(now, linkId, now - VIEW_THROTTLE_MS);
}

interface ImageRow {
	id: number;
	kind: 'upload' | 'url_copy' | 'url_link';
	path: string | null;
	thumb: string | null;
	source: string | null;
}

export interface SharedImage {
	/** Small and full-size addresses: through the token for uploaded files, the original for linked ones */
	thumb: string;
	full: string;
}

const isWebUrl = (u: string | null): u is string => !!u && /^https?:\/\//i.test(u);

function imageUrls(token: string, im: ImageRow): SharedImage | null {
	if (im.kind === 'url_link') return isWebUrl(im.source) ? { thumb: im.source, full: im.source } : null;
	if (!im.path || !isSafeRelativePath(im.path)) return null;
	const base = `/s/${token}/media/${im.id}`;
	return { thumb: `${base}?size=thumb`, full: base };
}

export interface SharedCard {
	id: number;
	title: string;
	subtitle: string | null;
	status: string | null;
	statusLabel: string | null;
	/** In a "planned" status (Wishlist, Want to see…) */
	planned: boolean;
	rating: number | null;
	favorite: boolean;
	/** The list's card fields, ready to show */
	extra: string;
	lastLoggedAt: string | null;
	cover: string | null;
}

export interface SharedList {
	name: string;
	icon: string;
	color: string;
	owner: string;
	itemCount: number;
	/** What the planned section is called: the planned statuses in use, e.g. "Wishlist" */
	plannedLabel: string | null;
	items: SharedCard[];
}

/** A shared list's page: counts the visit */
export function viewSharedList(token: string, now = Date.now()): SharedList {
	const s = resolve(token, now);
	if (!s) notFound();
	recordView(s.linkId, now);

	const cardFields = s.itemFields.filter((f) => f.showOnCard);
	const hasSeason = cardFields.some((f) => f.key === 'current_season');
	const rows = rawDb()
		.prepare(
			`SELECT i.id, i.title, i.subtitle, i.status, i.rating, i.favorite, i.custom,
				i.last_logged_at AS lastLoggedAt,
				im.id AS imId, im.kind AS imKind, im.path AS imPath, im.thumb_path AS imThumb, im.source_url AS imSource
			 FROM items i
			 LEFT JOIN images im ON im.id = COALESCE(
				(SELECT c.id FROM images c WHERE c.id = i.cover_image_id AND c.item_id = i.id),
				(SELECT f.id FROM images f WHERE f.item_id = i.id ORDER BY f.sort_order, f.id LIMIT 1))
			 WHERE i.category_id = ? AND i.user_id = ?`
		)
		.all(s.categoryId, s.ownerId) as {
		id: number;
		title: string;
		subtitle: string | null;
		status: string | null;
		rating: number | null;
		favorite: number;
		custom: string;
		lastLoggedAt: string | null;
		imId: number | null;
		imKind: ImageRow['kind'] | null;
		imPath: string | null;
		imThumb: string | null;
		imSource: string | null;
	}[];

	const groups = new Map(s.statuses.map((st) => [st.key, st]));
	const used = new Set<string>();
	const items = rows.map((r): SharedCard => {
		const status = r.status ? (groups.get(r.status) ?? null) : null;
		if (status?.group === 'planned') used.add(status.key);
		const custom = parseJson(r.custom);
		const parts: string[] = [];
		for (const f of cardFields) {
			// TV progress reads "S3 E5" rather than "3 · 5"
			if (f.key === 'current_episode' && hasSeason) continue;
			const v = f.key === 'current_season' ? progressLabel(custom) : formatFieldValue(f, custom[f.key]);
			if (v) parts.push(v);
		}
		const cover = r.imId
			? imageUrls(token, {
					id: r.imId,
					kind: r.imKind!,
					path: r.imPath,
					thumb: r.imThumb,
					source: r.imSource
				})
			: null;
		return {
			id: r.id,
			title: r.title,
			subtitle: r.subtitle,
			status: r.status,
			statusLabel: status?.label ?? null,
			planned: status?.group === 'planned',
			rating: r.rating,
			favorite: !!r.favorite,
			extra: parts.join(' · '),
			lastLoggedAt: r.lastLoggedAt,
			cover: cover?.thumb ?? null
		};
	});

	return {
		name: s.name,
		icon: s.icon,
		color: s.color,
		owner: s.ownerName,
		itemCount: items.length,
		plannedLabel: plannedLabel(s.statuses, used),
		items
	};
}

/** The planned statuses in use, as one heading: "Wishlist" or "Planning / Wishlist" */
function plannedLabel(statuses: StatusDef[], used: Set<string>) {
	const labels = statuses.filter((st) => st.group === 'planned' && used.has(st.key)).map((st) => st.label);
	return labels.length ? Array.from(new Set(labels)).join(' / ') : null;
}

export interface SharedLog {
	id: number;
	date: string;
	rating: number | null;
	notes: string | null;
	location: string | null;
	price: number | null;
	/** "S2 E5 · Name" for a show's episodes */
	episodes: string | null;
	fields: { label: string; value: string }[];
	setlist: { tour: string | null; url: string | null; songs: SetlistEvent['songs'] } | null;
	images: SharedImage[];
}

export interface SharedItem {
	list: { name: string; icon: string; color: string; owner: string };
	title: string;
	subtitle: string | null;
	description: string | null;
	statusLabel: string | null;
	rating: number | null;
	favorite: boolean;
	notes: string | null;
	fields: { label: string; value: string }[];
	tags: string[];
	genres: string[];
	facts: MetadataFact[];
	images: SharedImage[];
	logs: SharedLog[];
	/** The owner's logs not shown (only the newest are) */
	moreLogs: number;
	/** last.fm plays are summed up, not listed */
	listening: { plays: number; lastPlayed: string | null } | null;
}

/** One item of a shared list: the owner's view of it, with their logs only */
export function viewSharedItem(token: string, itemId: number, now = Date.now()): SharedItem {
	const s = resolve(token, now);
	if (!s || !Number.isInteger(itemId)) notFound();
	const sqlite = rawDb();
	const item = sqlite
		.prepare(
			`SELECT id, title, subtitle, description, status, rating, favorite, notes, custom, metadata,
				cover_image_id AS cover
			 FROM items WHERE id = ? AND category_id = ? AND user_id = ?`
		)
		.get(itemId, s.categoryId, s.ownerId) as
		| {
				id: number;
				title: string;
				subtitle: string | null;
				description: string | null;
				status: string | null;
				rating: number | null;
				favorite: number;
				notes: string | null;
				custom: string;
				metadata: string | null;
				cover: number | null;
		  }
		| undefined;
	if (!item) notFound();

	const custom = parseJson(item.custom);
	const filled = (def: FieldDef, values: Record<string, unknown>) => {
		const v = values[def.key];
		return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
	};
	const fields = s.itemFields
		.filter((f) => !PROGRESS_KEYS.includes(f.key) && filled(f, custom))
		.map((f) => ({ label: f.label, value: formatFieldValue(f, custom[f.key]) }));

	const urls = (rows: ImageRow[]) =>
		rows.map((im) => imageUrls(token, im)).filter((x): x is SharedImage => !!x);
	const itemImages = sqlite
		.prepare(
			`SELECT id, kind, path, thumb_path AS thumb, source_url AS source FROM images
			 WHERE item_id = ? AND log_id IS NULL ORDER BY sort_order, id`
		)
		.all(item.id) as ImageRow[];
	// The chosen cover first
	itemImages.sort((a, b) => Number(b.id === item.cover) - Number(a.id === item.cover));

	// Only the owner's logs; imported last.fm plays are counted instead of listed
	const logWhere = "l.item_id = ? AND l.user_id = ? AND l.source IS NOT 'lastfm'";
	const logRows = sqlite
		.prepare(
			`SELECT l.id, l.date, l.rating, l.notes, l.location, l.price, l.custom, l.external,
				${logEpisodesSql('l')} AS ep
			 FROM item_logs l WHERE ${logWhere} ORDER BY l.date DESC, l.id DESC LIMIT ?`
		)
		.all(item.id, s.ownerId, LOG_CAP) as {
		id: number;
		date: string;
		rating: number | null;
		notes: string | null;
		location: string | null;
		price: number | null;
		custom: string;
		external: string | null;
		ep: string | null;
	}[];
	const logTotal = (
		sqlite.prepare(`SELECT COUNT(*) AS n FROM item_logs l WHERE ${logWhere}`).get(item.id, s.ownerId) as {
			n: number;
		}
	).n;
	const logImages = logRows.length
		? (sqlite
				.prepare(
					`SELECT id, kind, path, thumb_path AS thumb, source_url AS source, log_id AS logId FROM images
					 WHERE log_id IN (${logRows.map(() => '?').join(',')}) ORDER BY id`
				)
				.all(...logRows.map((l) => l.id)) as (ImageRow & { logId: number })[])
		: [];

	const logs = logRows.map((l): SharedLog => {
		const lc = parseJson(l.custom);
		const setlist = (parseJson(l.external).setlist ?? null) as Partial<SetlistEvent> | null;
		return {
			id: l.id,
			date: l.date,
			rating: l.rating,
			notes: l.notes,
			location: l.location,
			price: l.price,
			episodes: logEpisodeLabel(parseLogEpisodes(l.ep)),
			fields: s.logFields
				.filter((f) => filled(f, lc))
				.map((f) => ({ label: f.label, value: formatFieldValue(f, lc[f.key]) })),
			setlist: setlist ? cleanSetlist(setlist) : null,
			images: urls(logImages.filter((im) => im.logId === l.id))
		};
	});

	const listen = sqlite
		.prepare(
			'SELECT SUM(plays) AS plays, MAX(last_uts) AS lastUts FROM lastfm_albums WHERE user_id = ? AND item_id = ?'
		)
		.get(s.ownerId, item.id) as { plays: number | null; lastUts: number | null };

	const meta = (item.metadata ? parseJson(item.metadata) : {}) as {
		genres?: unknown;
		facts?: unknown;
	};
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	return {
		list: { name: s.name, icon: s.icon, color: s.color, owner: s.ownerName },
		title: item.title,
		subtitle: item.subtitle,
		description: item.description,
		statusLabel: s.statuses.find((st) => st.key === item.status)?.label ?? null,
		rating: item.rating,
		favorite: !!item.favorite,
		notes: item.notes,
		fields,
		tags: getItemTags(item.id),
		genres: Array.isArray(meta.genres) ? meta.genres.map(text).filter(Boolean) : [],
		facts: Array.isArray(meta.facts)
			? meta.facts
					.map((f) => ({ label: text((f as MetadataFact)?.label), value: text((f as MetadataFact)?.value) }))
					.filter((f) => f.label && f.value)
			: [],
		images: urls(itemImages),
		logs,
		moreLogs: Math.max(0, logTotal - logs.length),
		listening: listen.plays
			? { plays: listen.plays, lastPlayed: listen.lastUts ? localDay(listen.lastUts * 1000) : null }
			: null
	};
}

/** Only what the page shows of a setlist */
function cleanSetlist(sl: Partial<SetlistEvent>): SharedLog['setlist'] {
	const songs = Array.isArray(sl.songs) ? sl.songs : [];
	return {
		tour: typeof sl.tour === 'string' && sl.tour ? sl.tour : null,
		url: isWebUrl(sl.url ?? null) ? sl.url! : null,
		songs: songs
			.filter((x) => x && typeof x.name === 'string')
			.map((x) => ({
				name: x.name,
				...(typeof x.set === 'string' && x.set ? { set: x.set } : {}),
				...(typeof x.info === 'string' && x.info ? { info: x.info } : {}),
				...(typeof x.cover === 'string' && x.cover ? { cover: x.cover } : {})
			}))
	};
}

/**
 * The stored file behind an image on a shared list, or null: only photos of the list's items, and of
 * the owner's logs on them, are served, and only uploaded files (linked images load from their source).
 */
export function sharedImageFile(token: string, imageId: number, size: 'thumb' | 'full', now = Date.now()) {
	const s = resolve(token, now);
	if (!s || !Number.isInteger(imageId)) return null;
	const row = rawDb()
		.prepare(
			`SELECT im.kind, im.path, im.thumb_path AS thumb FROM images im
			 LEFT JOIN item_logs l ON l.id = im.log_id
			 JOIN items i ON i.id = IIF(im.log_id IS NULL, im.item_id, l.item_id)
			 WHERE im.id = ? AND i.category_id = ? AND (im.log_id IS NULL OR l.user_id = ?)`
		)
		.get(imageId, s.categoryId, s.ownerId) as
		{ kind: ImageRow['kind']; path: string | null; thumb: string | null } | undefined;
	if (!row || row.kind === 'url_link') return null;
	const rel = size === 'thumb' ? row.thumb || row.path : row.path;
	return rel && isSafeRelativePath(rel) ? rel : null;
}

function parseJson(s: string | null): Record<string, unknown> {
	try {
		const v = s ? JSON.parse(s) : {};
		return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}
