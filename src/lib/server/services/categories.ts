import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { db, schema } from '../db';
import { TEMPLATE_BY_KEY, DEFAULT_STATUSES, type CategoryTemplate } from '../templates';
import { fieldKey, slugify } from '$lib/fields';
import type { FieldDef, FieldScope, FieldType, RatingScale, StatusDef } from '$lib/types';
import type { Category, FieldDefinition } from '../db/schema';

export function listCategories(userId: number) {
	return db()
		.select({
			id: schema.categories.id,
			name: schema.categories.name,
			slug: schema.categories.slug,
			icon: schema.categories.icon,
			color: schema.categories.color,
			ratingScale: schema.categories.ratingScale,
			statuses: schema.categories.statuses,
			providerKinds: schema.categories.providerKinds,
			sortOrder: schema.categories.sortOrder,
			// Written out in full: an interpolated column renders unqualified and would bind to items.id
			itemCount: sql<number>`(SELECT COUNT(*) FROM items WHERE items.category_id = categories.id)`
		})
		.from(schema.categories)
		.where(eq(schema.categories.userId, userId))
		.orderBy(asc(schema.categories.sortOrder), asc(schema.categories.name))
		.all();
}

export type CategorySummary = ReturnType<typeof listCategories>[number];

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

export function getCategoryBySlug(userId: number, slug: string) {
	const category = db()
		.select()
		.from(schema.categories)
		.where(and(eq(schema.categories.userId, userId), eq(schema.categories.slug, slug)))
		.get();
	if (!category) error(404, 'Category not found');
	return withFields(category);
}

export function getCategoryById(userId: number, id: number) {
	const category = db()
		.select()
		.from(schema.categories)
		.where(and(eq(schema.categories.userId, userId), eq(schema.categories.id, id)))
		.get();
	if (!category) error(404, 'Category not found');
	return withFields(category);
}

function withFields(category: Category) {
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
	ratingScale: RatingScale;
	statuses: StatusDef[];
	providerKinds: string[];
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
			ratingScale: input.ratingScale,
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
				ratingScale: t.ratingScale,
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
	const existing = getCategoryById(userId, id).category;
	const slug = existing.name === input.name ? existing.slug : uniqueSlug(userId, input.name, id);
	db()
		.update(schema.categories)
		.set({
			name: input.name,
			slug,
			icon: input.icon || '📦',
			color: input.color,
			ratingScale: input.ratingScale,
			statuses: input.statuses,
			providerKinds: input.providerKinds
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
	return slug;
}

export function deleteCategory(userId: number, id: number) {
	db()
		.delete(schema.categories)
		.where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId)))
		.run();
}

export function moveCategory(userId: number, id: number, direction: -1 | 1) {
	const cats = listCategories(userId);
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

/** The category a provider result goes into by default. */
export function findCategoryForKind(userId: number, kindKey: string) {
	return listCategories(userId).find((c) => c.providerKinds.includes(kindKey)) ?? null;
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
