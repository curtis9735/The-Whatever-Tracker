import { and, asc, count, eq, max } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db, rawDb, schema } from '../db';
import { TEMPLATE_BY_KEY, DEFAULT_STATUSES, type CategoryTemplate } from '../templates';
import { fieldKey, slugify } from '$lib/fields';
import type { FieldDef, FieldScope, FieldType, ListAccess, StatusDef } from '$lib/types';
import type { Category, FieldDefinition } from '../db/schema';
import { requireAccess } from './access';

interface CategoryRow {
	id: number;
	name: string;
	slug: string;
	icon: string;
	color: string;
	statuses: string;
	providerKinds: string;
	sortOrder: number;
	itemCount: number;
	access: ListAccess;
	ownerName: string | null;
	ownerUsername: string;
	sharedWith: number;
}

/**
 * The viewer's lists, then the lists others share with them. `slug` is how the viewer reaches a list:
 * a shared list's is `slug@owner` (/c/whiskey@daniel), as two people can each have a "whiskey" list.
 */
export function listCategories(userId: number) {
	const rows = rawDb()
		.prepare(
			`SELECT c.id, c.name, c.slug, c.icon, c.color, c.statuses, c.provider_kinds AS providerKinds,
				c.sort_order AS sortOrder,
				(SELECT COUNT(*) FROM items WHERE items.category_id = c.id) AS itemCount,
				IIF(c.user_id = me.id, 'owner', sh.role) AS access,
				IIF(c.user_id = me.id, NULL, u.display_name) AS ownerName, u.username AS ownerUsername,
				(SELECT COUNT(*) FROM list_shares x WHERE x.category_id = c.id) AS sharedWith
			 FROM (SELECT ? AS id) me CROSS JOIN categories c
			 JOIN users u ON u.id = c.user_id
			 LEFT JOIN list_shares sh ON sh.category_id = c.id AND sh.user_id = me.id
			 WHERE c.user_id = me.id OR sh.user_id IS NOT NULL
			 ORDER BY c.user_id != me.id, IIF(c.user_id = me.id, c.sort_order, 0), c.name COLLATE NOCASE`
		)
		.all(userId) as CategoryRow[];
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		slug: r.access === 'owner' ? r.slug : sharedSlug(r.slug, r.ownerUsername),
		icon: r.icon,
		color: r.color,
		statuses: JSON.parse(r.statuses) as StatusDef[],
		providerKinds: JSON.parse(r.providerKinds) as string[],
		sortOrder: r.sortOrder,
		itemCount: r.itemCount,
		/** The viewer's: owner, edit or view */
		access: r.access,
		/** Whose list it is, when it isn't the viewer's */
		ownerName: r.ownerName,
		/** How many people it's shared with */
		sharedWith: r.sharedWith
	}));
}

export type CategorySummary = ReturnType<typeof listCategories>[number];

/** Lists new items can go into: the viewer's own, and shared lists they can edit */
export function editableCategories(userId: number) {
	return listCategories(userId).filter((c) => c.access !== 'view');
}

/** A list shared with the viewer, as they reach it: `slug@owner` */
export const sharedSlug = (slug: string, owner: string) => `${slug}@${owner}`;

export function toFieldDef(f: FieldDefinition): FieldDef {
	return {
		key: f.key,
		label: f.label,
		type: f.type,
		scope: f.scope,
		options: f.options ?? [],
		unit: f.unit,
		showOnCard: f.showOnCard
	};
}

export function getFields(categoryId: number) {
	return db()
		.select()
		.from(schema.fieldDefinitions)
		.where(eq(schema.fieldDefinitions.categoryId, categoryId))
		.orderBy(asc(schema.fieldDefinitions.sortOrder), asc(schema.fieldDefinitions.id))
		.all();
}

/**
 * A list as the viewer sees it. For a list shared with them, `slug` is `slug@owner` (the path to it),
 * `showUpNext`/`showInCalendar` are their own choices, and `userId` is still the owner's.
 */
export type ViewCategory = Category & {
	access: ListAccess;
	/** Whose list it is, when it isn't the viewer's */
	ownerName: string | null;
	/** How many people it's shared with */
	sharedWith: number;
};

/**
 * `need`: 'view' to see it (anyone it's shared with), 'edit' to add or change its items, 'owner' for
 * its settings. A list the viewer can't see is a 404; one they can see but not change this way, a 403.
 */
export function getCategoryBySlug(userId: number, slug: string, need: ListAccess = 'view') {
	const at = slug.lastIndexOf('@');
	const category =
		at === -1
			? db()
					.select()
					.from(schema.categories)
					.where(and(eq(schema.categories.userId, userId), eq(schema.categories.slug, slug)))
					.get()
			: db()
					.select({ c: schema.categories })
					.from(schema.categories)
					.innerJoin(schema.users, eq(schema.users.id, schema.categories.userId))
					.where(
						and(eq(schema.categories.slug, slug.slice(0, at)), eq(schema.users.username, slug.slice(at + 1)))
					)
					.get()?.c;
	if (!category) error(404, 'Category not found');
	return withFields(viewCategory(userId, category, need));
}

export function getCategoryById(userId: number, id: number, need: ListAccess = 'view') {
	const category = db().select().from(schema.categories).where(eq(schema.categories.id, id)).get();
	if (!category) error(404, 'Category not found');
	return withFields(viewCategory(userId, category, need));
}

function viewCategory(userId: number, category: Category, need: ListAccess): ViewCategory {
	const sqlite = rawDb();
	const sharedWith = (
		sqlite.prepare('SELECT COUNT(*) AS n FROM list_shares WHERE category_id = ?').get(category.id) as {
			n: number;
		}
	).n;
	if (category.userId === userId) return { ...category, access: 'owner', ownerName: null, sharedWith };
	const share = sqlite
		.prepare(
			`SELECT s.role, s.show_up_next AS upNext, s.show_in_calendar AS inCalendar,
				u.username, u.display_name AS ownerName
			 FROM list_shares s JOIN users u ON u.id = ? WHERE s.category_id = ? AND s.user_id = ?`
		)
		.get(category.userId, category.id, userId) as
		{ role: ListAccess; upNext: number; inCalendar: number; username: string; ownerName: string } | undefined;
	requireAccess(share?.role, need, 'Category not found');
	return {
		...category,
		slug: sharedSlug(category.slug, share!.username),
		showUpNext: !!share!.upNext,
		showInCalendar: !!share!.inCalendar,
		access: share!.role,
		ownerName: share!.ownerName,
		sharedWith
	};
}

function withFields(category: ViewCategory) {
	const rows = getFields(category.id);
	const defs = rows.map(toFieldDef);
	return {
		category,
		fieldRows: rows,
		itemFields: defs.filter((f) => f.scope === 'item'),
		logFields: defs.filter((f) => f.scope === 'log')
	};
}

export function uniqueSlug(userId: number, base: string, excludeId?: number) {
	const root = slugify(base);
	let slug = root;
	for (let i = 2; ; i++) {
		const taken = db()
			.select({ id: schema.categories.id })
			.from(schema.categories)
			.where(and(eq(schema.categories.userId, userId), eq(schema.categories.slug, slug)))
			.get();
		if (!taken || taken.id === excludeId) return slug;
		slug = `${root}-${i}`;
	}
}

function nextSortOrder(userId: number) {
	const row = db()
		.select({ m: max(schema.categories.sortOrder) })
		.from(schema.categories)
		.where(eq(schema.categories.userId, userId))
		.get();
	return (row?.m ?? -1) + 1;
}

export interface CategoryInput {
	name: string;
	icon: string;
	color: string;
	statuses: StatusDef[];
	providerKinds: string[];
	/** Planned items appear in "Up next" on the home page (on unless turned off) */
	showUpNext?: boolean;
	/** Releases of this list's shows, movies and games appear in the Calendar (on unless turned off) */
	showInCalendar?: boolean;
}

export function createCategory(userId: number, input: CategoryInput, templateKey: string | null = null) {
	const row = db()
		.insert(schema.categories)
		.values({
			userId,
			name: input.name,
			slug: uniqueSlug(userId, input.name),
			icon: input.icon || '📦',
			color: input.color,
			statuses: input.statuses.length ? input.statuses : DEFAULT_STATUSES,
			providerKinds: input.providerKinds,
			templateKey,
			sortOrder: nextSortOrder(userId)
		})
		.returning()
		.get();
	return row;
}

export interface FieldInput {
	label: string;
	type: FieldType;
	scope: FieldScope;
	options?: string[];
	unit?: string | null;
	showOnCard?: boolean;
	/** Preferred key; a number is added if the list already uses it */
	key?: string;
}

/** Adds a field to a list: unique key within its scope, placed after the existing fields. */
export function addFieldDefinition(categoryId: number, input: FieldInput) {
	const taken = new Set(
		getFields(categoryId)
			.filter((f) => f.scope === input.scope)
			.map((f) => f.key)
	);
	const base = input.key ?? fieldKey(input.label);
	let key = base;
	for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
	const order = db()
		.select({ m: max(schema.fieldDefinitions.sortOrder) })
		.from(schema.fieldDefinitions)
		.where(eq(schema.fieldDefinitions.categoryId, categoryId))
		.get();
	return db()
		.insert(schema.fieldDefinitions)
		.values({
			categoryId,
			scope: input.scope,
			key,
			label: input.label,
			type: input.type,
			options: input.options ?? [],
			unit: input.unit ?? null,
			showOnCard: input.showOnCard ?? false,
			sortOrder: (order?.m ?? -1) + 1
		})
		.returning()
		.get();
}

export interface FieldChange {
	/** null for a field added on the settings page */
	id: number | null;
	scope: FieldScope;
	/** Only used for new fields; an existing field keeps its type */
	type: FieldType;
	label: string;
	unit: string | null;
	options: string[];
	showOnCard: boolean;
	removed: boolean;
}

/**
 * Applies the field list from the settings page in one go: renames, choices, cards, removals,
 * new fields, and their order (the order of `changes`). Fields the page didn't send keep their
 * place after the others. A removed field's values stay in the items, so re-adding a field with
 * the same name brings them back.
 */
export function saveFieldChanges(categoryId: number, changes: FieldChange[]) {
	const left = new Map(getFields(categoryId).map((f) => [f.id, f]));
	const order: number[] = [];
	for (const c of changes) {
		if (c.id === null) {
			if (c.removed) continue;
			const row = addFieldDefinition(categoryId, {
				label: c.label,
				type: c.type,
				scope: c.scope,
				options: c.options,
				unit: c.unit,
				showOnCard: c.showOnCard
			});
			order.push(row.id);
			continue;
		}
		const current = left.get(c.id);
		if (!current) continue; // not this list's field
		left.delete(c.id);
		if (c.removed) {
			db().delete(schema.fieldDefinitions).where(eq(schema.fieldDefinitions.id, c.id)).run();
			continue;
		}
		const picks = current.type === 'select' || current.type === 'multiselect';
		db()
			.update(schema.fieldDefinitions)
			.set({
				label: c.label,
				unit: c.unit,
				options: picks ? c.options : current.options,
				showOnCard: c.showOnCard
			})
			.where(eq(schema.fieldDefinitions.id, c.id))
			.run();
		order.push(c.id);
	}
	for (const f of left.values()) order.push(f.id);
	order.forEach((id, i) =>
		db().update(schema.fieldDefinitions).set({ sortOrder: i }).where(eq(schema.fieldDefinitions.id, id)).run()
	);
}

/** Adds choices to a pick-one / pick-several item field (keeps the ones it has; at most 100). */
export function addSelectOptions(categoryId: number, key: string, values: string[]) {
	const field = db()
		.select()
		.from(schema.fieldDefinitions)
		.where(
			and(
				eq(schema.fieldDefinitions.categoryId, categoryId),
				eq(schema.fieldDefinitions.key, key),
				eq(schema.fieldDefinitions.scope, 'item')
			)
		)
		.get();
	if (!field || (field.type !== 'select' && field.type !== 'multiselect')) return;
	const have = new Set((field.options ?? []).map((o) => o.toLowerCase()));
	const added = values.filter((v) => !have.has(v.toLowerCase()));
	if (!added.length) return;
	const options = [...new Set([...(field.options ?? []), ...added])].slice(0, 100);
	db().update(schema.fieldDefinitions).set({ options }).where(eq(schema.fieldDefinitions.id, field.id)).run();
}

export function createCategoryFromTemplate(userId: number, templateKey: string) {
	const t = TEMPLATE_BY_KEY.get(templateKey);
	if (!t) throw new Error(`Unknown template ${templateKey}`);
	return createFromTemplate(userId, t);
}

function createFromTemplate(userId: number, t: CategoryTemplate) {
	return db().transaction(() => {
		const category = createCategory(
			userId,
			{
				name: t.name,
				icon: t.icon,
				color: t.color,
				statuses: t.statuses,
				providerKinds: t.providerKinds
			},
			t.key
		);
		t.fields.forEach((f, i) => {
			db()
				.insert(schema.fieldDefinitions)
				.values({
					categoryId: category.id,
					scope: f.scope ?? 'item',
					key: f.key,
					label: f.label,
					type: f.type,
					options: f.options ?? [],
					unit: f.unit ?? null,
					showOnCard: f.showOnCard ?? false,
					sortOrder: i
				})
				.run();
		});
		return category;
	});
}

export function updateCategory(userId: number, id: number, input: CategoryInput) {
	const existing = getCategoryById(userId, id, 'owner').category;
	const slug = existing.name === input.name ? existing.slug : uniqueSlug(userId, input.name, id);
	db()
		.update(schema.categories)
		.set({
			name: input.name,
			slug,
			icon: input.icon || '📦',
			color: input.color,
			statuses: input.statuses,
			providerKinds: input.providerKinds,
			...(input.showUpNext !== undefined ? { showUpNext: input.showUpNext } : {}),
			...(input.showInCalendar !== undefined ? { showInCalendar: input.showInCalendar } : {})
		})
		.where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId)))
		.run();

	// Items whose status no longer exists fall back to the first status
	const keys = new Set(input.statuses.map((s) => s.key));
	const first = input.statuses[0]?.key ?? null;
	const rows = db()
		.select({ id: schema.items.id, status: schema.items.status })
		.from(schema.items)
		.where(eq(schema.items.categoryId, id))
		.all();
	for (const r of rows) {
		if (r.status && !keys.has(r.status)) {
			db().update(schema.items).set({ status: first }).where(eq(schema.items.id, r.id)).run();
		}
	}
	// …and so do the statuses of the people it's shared with
	const progress = rawDb()
		.prepare(
			`SELECT p.item_id AS itemId, p.user_id AS userId, p.status FROM item_progress p
			 JOIN items i ON i.id = p.item_id WHERE i.category_id = ? AND p.status IS NOT NULL`
		)
		.all(id) as { itemId: number; userId: number; status: string }[];
	const fallBack = rawDb().prepare('UPDATE item_progress SET status = ? WHERE item_id = ? AND user_id = ?');
	for (const r of progress) if (!keys.has(r.status)) fallBack.run(first, r.itemId, r.userId);
	return slug;
}

export function deleteCategory(userId: number, id: number) {
	db()
		.delete(schema.categories)
		.where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId)))
		.run();
}

export function moveCategory(userId: number, id: number, direction: -1 | 1) {
	const cats = listCategories(userId).filter((c) => c.access === 'owner');
	const idx = cats.findIndex((c) => c.id === id);
	const swap = idx + direction;
	if (idx < 0 || swap < 0 || swap >= cats.length) return;
	[cats[idx], cats[swap]] = [cats[swap], cats[idx]];
	db().transaction(() => {
		cats.forEach((c, i) => {
			db().update(schema.categories).set({ sortOrder: i }).where(eq(schema.categories.id, c.id)).run();
		});
	});
}

/** The category a provider result goes into by default: the viewer's own lists first, then ones shared with them to edit. */
export function findCategoryForKind(userId: number, kindKey: string) {
	return editableCategories(userId).find((c) => c.providerKinds.includes(kindKey)) ?? null;
}

export function categoryItemCount(categoryId: number) {
	return (
		db().select({ n: count() }).from(schema.items).where(eq(schema.items.categoryId, categoryId)).get()?.n ??
		0
	);
}

export function statusLabel(statuses: StatusDef[], key: string | null) {
	if (!key) return null;
	return statuses.find((s) => s.key === key)?.label ?? key;
}

export function statusGroup(statuses: StatusDef[], key: string | null) {
	if (!key) return null;
	return statuses.find((s) => s.key === key)?.group ?? null;
}
