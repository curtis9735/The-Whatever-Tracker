import { rawDb } from '../db';
import type { LocalSearchHit, RatingScale } from '$lib/types';
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
	rating_scale: RatingScale;
	statuses: string;
	img_kind: ImageRef['kind'] | null;
	img_path: string | null;
	img_thumb: string | null;
	img_source: string | null;
}

const HIT_COLUMNS = `
	i.id, i.title, i.subtitle, i.status, i.rating,
	c.name AS category_name, c.icon AS category_icon, c.slug AS category_slug,
	c.rating_scale, c.statuses,
	im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source`;

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
		ratingScale: r.rating_scale,
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
			 FROM items_fts f
			 JOIN items i ON i.id = f.rowid
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE items_fts MATCH ? AND i.user_id = ?
			 ORDER BY bm25(items_fts, 10.0, 4.0, 1.0)
			 LIMIT ?`
		)
		.all(query, userId, limit) as HitRow[];
	return rows.map(toHit);
}

export function findByBarcode(userId: number, code: string): LocalSearchHit[] {
	const rows = rawDb()
		.prepare(
			`SELECT ${HIT_COLUMNS}
			 FROM items i
			 JOIN categories c ON c.id = i.category_id
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE i.user_id = ? AND i.barcode = ?
			 LIMIT 10`
		)
		.all(userId, code) as HitRow[];
	return rows.map(toHit);
}

/** Which provider results are already in the user's library: returns "provider:kind:id" → item id. */
export function libraryMatches(
	userId: number,
	refs: { provider: string; kind: string; id: string }[]
): Record<string, number> {
	if (!refs.length) return {};
	const sqlite = rawDb();
	const stmt = sqlite.prepare(
		'SELECT id FROM items WHERE user_id = ? AND provider = ? AND provider_kind = ? AND provider_id = ?'
	);
	const out: Record<string, number> = {};
	for (const r of refs) {
		const row = stmt.get(userId, r.provider, r.kind, r.id) as { id: number } | undefined;
		if (row) out[`${r.provider}:${r.kind}:${r.id}`] = row.id;
	}
	return out;
}
