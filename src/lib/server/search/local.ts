import { rawDb } from '../db';
import { ME, mine, PROGRESS_JOIN, SEES_LIST, SHARE_JOIN } from '../services/access';
import type { LocalSearchHit } from '$lib/types';
import { imageSrc, type ImageRef } from '$lib/images';

/** Turns free text into a safe FTS5 query: every word must match, last-typed words as prefixes. */
export function buildFtsQuery(input: string): string | null {
	const tokens = input
		.normalize('NFKC')
		.split(/[\s\p{P}\p{S}]+/u)
		.map((t) => t.trim())
		.filter(Boolean)
		.slice(0, 8);
	if (!tokens.length) return null;
	return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function valuesToText(obj: unknown): string {
	if (!obj || typeof obj !== 'object') return '';
	return Object.values(obj as Record<string, unknown>)
		.flatMap((v) => (Array.isArray(v) ? v : [v]))
		.filter((v) => typeof v === 'string' || typeof v === 'number')
		.join(' ');
}

/** Rebuilds the search document for one item (title, tags, custom fields, log notes...). */
export function reindexItem(itemId: number) {
	const sqlite = rawDb();
	const item = sqlite
		.prepare(
			'SELECT id, title, subtitle, description, notes, custom, barcode, metadata FROM items WHERE id = ?'
		)
		.get(itemId) as
		| {
				id: number;
				title: string;
				subtitle: string | null;
				description: string | null;
				notes: string | null;
				custom: string;
				barcode: string | null;
				metadata: string | null;
		  }
		| undefined;
	sqlite.prepare('DELETE FROM items_fts WHERE rowid = ?').run(itemId);
	if (!item) return;

	const tagNames = (
		sqlite
			.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?')
			.all(itemId) as { name: string }[]
	).map((r) => r.name);
	const logs = sqlite
		.prepare('SELECT notes, location, custom FROM item_logs WHERE item_id = ?')
		.all(itemId) as { notes: string | null; location: string | null; custom: string }[];

	// Notes of the people a list is shared with (the owner's are on the item)
	const progressNotes = (
		sqlite.prepare('SELECT notes FROM item_progress WHERE item_id = ? AND notes IS NOT NULL').all(itemId) as {
			notes: string;
		}[]
	).map((r) => r.notes);

	let genres = '';
	try {
		const meta = item.metadata ? JSON.parse(item.metadata) : null;
		if (meta && Array.isArray(meta.genres)) genres = meta.genres.join(' ');
	} catch {
		/* ignore malformed metadata */
	}

	const body = [
		item.description,
		item.notes,
		...progressNotes,
		item.barcode,
		genres,
		tagNames.join(' '),
		valuesToText(safeJson(item.custom)),
		...logs.map((l) => [l.notes, l.location, valuesToText(safeJson(l.custom))].filter(Boolean).join(' '))
	]
		.filter(Boolean)
		.join('\n');

	sqlite
		.prepare('INSERT INTO items_fts (rowid, title, subtitle, body) VALUES (?, ?, ?, ?)')
		.run(itemId, item.title, item.subtitle ?? '', body);
}

function safeJson(s: string | null) {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

interface HitRow {
	id: number;
	title: string;
	subtitle: string | null;
	status: string | null;
	rating: number | null;
	category_name: string;
	category_icon: string;
	category_slug: string;
	statuses: string;
	img_kind: ImageRef['kind'] | null;
	img_path: string | null;
	img_thumb: string | null;
	img_source: string | null;
}

// Hits come from every list the viewer can see, with their own status and rating. A shared list's
// slug is how they reach it: slug@owner. Queries bind the viewer's id first (see access.ts).
const HIT_COLUMNS = `
	i.id, i.title, i.subtitle, ${mine('status')} AS status, ${mine('rating')} AS rating,
	c.name AS category_name, c.icon AS category_icon,
	IIF(c.user_id = me.id, c.slug, c.slug || '@' || u.username) AS category_slug,
	c.statuses,
	im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source`;

/** The rest of HIT_COLUMNS' joins, once items `i` and their lists `c` (with SHARE_JOIN) are in */
const HIT_JOINS = `
	JOIN users u ON u.id = c.user_id
	${PROGRESS_JOIN}
	LEFT JOIN images im ON im.id = i.cover_image_id`;

/**
 * Items on the lists the viewer can see, found list by list so the owner's indexes on items are used
 * (an item's owner is its list's owner). Use with `WHERE ${VISIBLE} AND i.category_id = c.id AND …`.
 */
const VISIBLE_ITEMS = `${ME} CROSS JOIN categories c ${SHARE_JOIN} CROSS JOIN items i`;
const VISIBLE = `${SEES_LIST} AND i.user_id = c.user_id`;

function toHit(r: HitRow): LocalSearchHit {
	let statusLabel = r.status;
	try {
		const statuses = JSON.parse(r.statuses) as { key: string; label: string }[];
		statusLabel = statuses.find((s) => s.key === r.status)?.label ?? r.status;
	} catch {
		/* keep raw key */
	}
	return {
		id: r.id,
		title: r.title,
		subtitle: r.subtitle,
		categoryName: r.category_name,
		categoryIcon: r.category_icon,
		categorySlug: r.category_slug,
		status: statusLabel,
		rating: r.rating,
		imageUrl: r.img_kind
			? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
			: null
	};
}

export function searchLocal(userId: number, q: string, limit = 20): LocalSearchHit[] {
	const query = buildFtsQuery(q);
	if (!query) return [];
	const sqlite = rawDb();
	const rows = sqlite
		.prepare(
			`SELECT ${HIT_COLUMNS}
			 FROM ${ME} CROSS JOIN items_fts f
			 JOIN items i ON i.id = f.rowid
			 JOIN categories c ON c.id = i.category_id
			 ${SHARE_JOIN}
			 ${HIT_JOINS}
			 WHERE items_fts MATCH ? AND ${SEES_LIST}
			 ORDER BY bm25(items_fts, 10.0, 4.0, 1.0)
			 LIMIT ?`
		)
		.all(userId, query, limit) as HitRow[];
	return rows.map(toHit);
}

/** Items with this barcode on lists the viewer can see, their own first */
export function findByBarcode(userId: number, code: string): LocalSearchHit[] {
	const rows = rawDb()
		.prepare(
			`SELECT ${HIT_COLUMNS}
			 FROM ${VISIBLE_ITEMS}
			 ${HIT_JOINS}
			 -- The unary + looks the items up by barcode rather than by list
			 WHERE ${VISIBLE} AND +i.category_id = c.id AND i.barcode = ?
			 ORDER BY i.user_id != me.id, i.id
			 LIMIT 10`
		)
		.all(userId, code) as HitRow[];
	return rows.map(toHit);
}

/**
 * Which provider results are already on a list the viewer can see (their own first):
 * returns "provider:kind:id" → item id.
 */
export function libraryMatches(
	userId: number,
	refs: { provider: string; kind: string; id: string }[]
): Record<string, number> {
	if (!refs.length) return {};
	const sqlite = rawDb();
	const stmt = sqlite.prepare(
		`SELECT i.id FROM ${VISIBLE_ITEMS}
		 WHERE ${VISIBLE} AND i.category_id = c.id
			AND i.provider = ? AND i.provider_kind = ? AND i.provider_id = ?
		 ORDER BY i.user_id != me.id, i.id LIMIT 1`
	);
	const out: Record<string, number> = {};
	for (const r of refs) {
		const row = stmt.get(userId, r.provider, r.kind, r.id) as { id: number } | undefined;
		if (row) out[`${r.provider}:${r.kind}:${r.id}`] = row.id;
	}
	return out;
}
