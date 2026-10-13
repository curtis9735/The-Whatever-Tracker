import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { reindexItem } from '../search/local';
import { addFieldDefinition, addSelectOptions, getCategoryById } from '../services/categories';
import { firstDoneStatus, setTags } from '../services/items';
import {
	buildRows,
	countRows,
	normTitle,
	planNewFields,
	validateMapping,
	withNewFields,
	type BuiltRow,
	type Counts,
	type ImportMapping,
	type ListContext
} from '$lib/import/sheet';
import { parseTable } from '$lib/import/table';
import { ImportError } from './yamtrack';

export const MAX_SHEET_TEXT = 8 * 1024 * 1024;

/** Titles already in a list, normalized, so the import can tell new items from ones to update. */
export function existingTitles(categoryId: number) {
	const rows = db()
		.select({ id: schema.items.id, title: schema.items.title })
		.from(schema.items)
		.where(eq(schema.items.categoryId, categoryId))
		.orderBy(schema.items.id)
		.all();
	const out: Record<string, number> = {};
	for (const r of rows) {
		const k = normTitle(r.title);
		if (k && !(k in out)) out[k] = r.id;
	}
	return out;
}

export function listContext(userId: number, categoryId: number): ListContext {
	const { category, itemFields, logFields } = getCategoryById(userId, categoryId);
	return {
		name: category.name,
		ratingScale: category.ratingScale,
		statuses: category.statuses,
		itemFields,
		logFields,
		existing: existingTitles(category.id)
	};
}

export interface SheetImportResult extends Counts {
	newFields: string[];
	addedChoices: number;
}

/** What the import would do: the same work as applySheetImport, without saving anything. */
export function previewSheetImport(
	userId: number,
	categoryId: number,
	text: string,
	mapping: ImportMapping,
	skipped: number[]
) {
	const { rows, newFields } = plan(userId, categoryId, text, mapping);
	return { counts: countRows(rows, new Set(skipped)), newFields: newFields.map((f) => f.label) };
}

function plan(userId: number, categoryId: number, text: string, mapping: ImportMapping) {
	if (text.length > MAX_SHEET_TEXT) throw new ImportError('That is too much data for one import.');
	const table = parseTable(text);
	if (!table.headers.length || !table.rows.length) throw new ImportError('There are no rows to import.');
	const base = listContext(userId, categoryId);
	const bad = validateMapping(mapping, table, base);
	if (bad) throw new ImportError(bad);
	const newFields = planNewFields(table, mapping, base);
	const resolved = withNewFields(mapping, base, newFields);
	return { table, ctx: resolved.ctx, rows: buildRows(table, resolved.mapping, resolved.ctx), newFields };
}

export function applySheetImport(
	userId: number,
	categoryId: number,
	text: string,
	mapping: ImportMapping,
	skipped: number[]
): SheetImportResult {
	const { ctx, rows, newFields } = plan(userId, categoryId, text, mapping);
	const skip = new Set(skipped);
	const chosen = rows.filter((r) => r.result !== 'blank' && !skip.has(r.index));
	const firstStatus = ctx.statuses[0]?.key ?? null;
	const doneKey = firstDoneStatus(ctx.statuses);
	const groupOf = new Map(ctx.statuses.map((s) => [s.key, s.group]));

	const byName = new Map(Object.entries(ctx.existing));
	const tagWork = new Map<number, string[]>();
	const touched = new Set<number>();
	let created = 0;
	let updated = 0;
	let logsAdded = 0;
	let addedChoices = 0;

	db().transaction(() => {
		// New fields first, with the keys the preview showed
		for (const f of newFields) {
			const row = addFieldDefinition(categoryId, { label: f.label, type: f.type, scope: 'item', key: f.key });
			if (row.key !== f.key) throw new ImportError('A field name clashed while importing. Try again.');
		}
		const choices = new Map<string, Set<string>>();
		for (const r of chosen) {
			for (const [key, list] of Object.entries(r.newChoices)) {
				const set = choices.get(key) ?? new Set<string>();
				list.forEach((v) => set.add(v));
				choices.set(key, set);
			}
		}
		for (const [key, set] of choices) {
			addSelectOptions(categoryId, key, [...set]);
			addedChoices += set.size;
		}

		for (const r of chosen) {
			const norm = normTitle(r.name);
			const existingId = byName.get(norm) ?? null;
			const itemId = existingId ? updateExisting(existingId, r) : createNew(r, norm);
			if (existingId) updated++;
			else created++;
			if (r.tags.length) tagWork.set(itemId, [...(tagWork.get(itemId) ?? []), ...r.tags]);
			if (r.image) addLink(itemId, r.image);
			if (r.log && addLog(itemId, r.log)) {
				logsAdded++;
				promoteIfPlanned(itemId);
			}
			touched.add(itemId);
		}
	});

	// Tags and the search index, once everything is saved
	for (const [itemId, names] of tagWork) {
		const current = db()
			.select({ name: schema.tags.name })
			.from(schema.itemTags)
			.innerJoin(schema.tags, eq(schema.itemTags.tagId, schema.tags.id))
			.where(eq(schema.itemTags.itemId, itemId))
			.all()
			.map((t) => t.name);
		setTags(userId, itemId, [...new Set([...current, ...names])]);
	}
	for (const id of touched) reindexItem(id);

	const counts = { ...countRows(rows, skip), created, updated, logs: logsAdded };
	return { ...counts, newFields: newFields.map((f) => f.label), addedChoices };

	function createNew(r: BuiltRow, norm: string) {
		const now = new Date();
		const row = db()
			.insert(schema.items)
			.values({
				userId,
				categoryId,
				title: r.name,
				subtitle: r.subtitle ?? null,
				status: r.status ?? firstStatus,
				rating: r.rating ?? null,
				barcode: r.barcode ?? null,
				notes: r.notes ?? null,
				custom: r.custom,
				createdAt: now,
				updatedAt: now
			})
			.returning({ id: schema.items.id })
			.get();
		byName.set(norm, row.id);
		return row.id;
	}

	/** Cells with something in them win; blanks never erase what's there. */
	function updateExisting(id: number, r: BuiltRow) {
		const cur = db().select().from(schema.items).where(eq(schema.items.id, id)).get()!;
		const patch: Partial<typeof schema.items.$inferInsert> = { updatedAt: new Date() };
		if (r.subtitle) patch.subtitle = r.subtitle;
		if (r.barcode) patch.barcode = r.barcode;
		if (r.status && !r.statusFromBlank) patch.status = r.status;
		if (r.rating !== undefined && r.rating !== null) patch.rating = r.rating;
		if (Object.keys(r.custom).length) patch.custom = { ...cur.custom, ...r.custom };
		if (r.notes && !(cur.notes ?? '').includes(r.notes)) {
			patch.notes = cur.notes ? `${cur.notes}\n\n${r.notes}` : r.notes;
		}
		db().update(schema.items).set(patch).where(eq(schema.items.id, id)).run();
		return id;
	}

	function addLink(itemId: number, url: string) {
		const have = db()
			.select({ id: schema.images.id })
			.from(schema.images)
			.where(and(eq(schema.images.itemId, itemId), eq(schema.images.sourceUrl, url)))
			.get();
		if (have) return;
		const img = db()
			.insert(schema.images)
			.values({ userId, itemId, kind: 'url_link', sourceUrl: url })
			.returning({ id: schema.images.id })
			.get();
		const item = db()
			.select({ cover: schema.items.coverImageId })
			.from(schema.items)
			.where(eq(schema.items.id, itemId))
			.get();
		if (!item?.cover)
			db().update(schema.items).set({ coverImageId: img.id }).where(eq(schema.items.id, itemId)).run();
	}

	/** One log per date; importing the same sheet again adds nothing. */
	function addLog(itemId: number, l: NonNullable<BuiltRow['log']>) {
		const dup = db()
			.select({ id: schema.itemLogs.id })
			.from(schema.itemLogs)
			.where(and(eq(schema.itemLogs.itemId, itemId), eq(schema.itemLogs.date, l.date)))
			.get();
		if (dup) return false;
		const item = db()
			.select({ rating: schema.items.rating })
			.from(schema.items)
			.where(eq(schema.items.id, itemId))
			.get();
		db()
			.insert(schema.itemLogs)
			.values({
				itemId,
				userId,
				date: l.date,
				rating: item?.rating ?? null,
				notes: l.notes ?? null,
				location: l.where ?? null,
				custom: l.custom
			})
			.run();
		db()
			.update(schema.items)
			.set({
				lastLoggedAt: db()
					.select({ d: schema.itemLogs.date })
					.from(schema.itemLogs)
					.where(eq(schema.itemLogs.itemId, itemId))
					.orderBy(schema.itemLogs.date)
					.all()
					.at(-1)!.d
			})
			.where(eq(schema.items.id, itemId))
			.run();
		return true;
	}

	/** Same rule as logging by hand: a logged wishlist item has been done. */
	function promoteIfPlanned(itemId: number) {
		const item = db()
			.select({ status: schema.items.status })
			.from(schema.items)
			.where(eq(schema.items.id, itemId))
			.get();
		const group = item?.status ? groupOf.get(item.status) : null;
		if ((!item?.status || group === 'planned') && doneKey) {
			db().update(schema.items).set({ status: doneKey }).where(eq(schema.items.id, itemId)).run();
		}
	}
}
