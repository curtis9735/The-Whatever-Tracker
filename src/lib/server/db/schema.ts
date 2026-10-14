import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { FieldScope, FieldType, StatusDef } from '$lib/types';

const createdAt = () =>
	integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date());

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	displayName: text('display_name').notNull(),
	passwordHash: text('password_hash').notNull(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	onboarded: integer('onboarded', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt()
});

export const sessions = sqliteTable(
	'sessions',
	{
		// sha256 of the token stored in the cookie, so a leaked DB can't be used to hijack sessions
		id: text('id').primaryKey(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

export const categories = sqliteTable(
	'categories',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		icon: text('icon').notNull().default('📦'),
		color: text('color').notNull().default('slate'),
		statuses: text('statuses', { mode: 'json' }).$type<StatusDef[]>().notNull(),
		providerKinds: text('provider_kinds', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		templateKey: text('template_key'),
		/** Planned items from this list appear in "Up next" on the home page */
		showUpNext: integer('show_up_next', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('categories_user_slug_idx').on(t.userId, t.slug)]
);

export const fieldDefinitions = sqliteTable(
	'field_definitions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		categoryId: integer('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'cascade' }),
		scope: text('scope').$type<FieldScope>().notNull().default('item'),
		key: text('key').notNull(),
		label: text('label').notNull(),
		type: text('type').$type<FieldType>().notNull(),
		options: text('options', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		unit: text('unit'),
		sortOrder: integer('sort_order').notNull().default(0),
		showOnCard: integer('show_on_card', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [uniqueIndex('fields_category_scope_key_idx').on(t.categoryId, t.scope, t.key)]
);

export const items = sqliteTable(
	'items',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		categoryId: integer('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		subtitle: text('subtitle'),
		description: text('description'),
		status: text('status'),
		/** 0–100 in tens: a whole number out of 10 */
		rating: integer('rating'),
		favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
		barcode: text('barcode'),
		notes: text('notes'),
		coverImageId: integer('cover_image_id'),
		provider: text('provider'),
		providerKind: text('provider_kind'),
		providerId: text('provider_id'),
		externalUrl: text('external_url'),
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
		custom: text('custom', { mode: 'json' })
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'`),
		lastLoggedAt: text('last_logged_at'),
		createdAt: createdAt(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(t) => [
		index('items_user_category_idx').on(t.userId, t.categoryId),
		index('items_user_barcode_idx').on(t.userId, t.barcode),
		// NULL providers never collide in SQLite unique indexes, so manual items are unaffected
		uniqueIndex('items_user_provider_idx').on(t.userId, t.provider, t.providerKind, t.providerId)
	]
);

export const itemLogs = sqliteTable(
	'item_logs',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** YYYY-MM-DD */
		date: text('date').notNull(),
		rating: integer('rating'),
		notes: text('notes'),
		location: text('location'),
		price: real('price'),
		custom: text('custom', { mode: 'json' })
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'`),
		external: text('external', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: createdAt()
	},
	(t) => [index('logs_item_idx').on(t.itemId), index('logs_user_date_idx').on(t.userId, t.date)]
);

export const images = sqliteTable(
	'images',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		itemId: integer('item_id').references(() => items.id, { onDelete: 'cascade' }),
		logId: integer('log_id').references(() => itemLogs.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<'upload' | 'url_copy' | 'url_link'>().notNull(),
		/** Relative to the uploads dir, for upload/url_copy */
		path: text('path'),
		thumbPath: text('thumb_path'),
		sourceUrl: text('source_url'),
		width: integer('width'),
		height: integer('height'),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: createdAt()
	},
	(t) => [index('images_item_idx').on(t.itemId), index('images_log_idx').on(t.logId)]
);

export const tags = sqliteTable(
	'tags',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull()
	},
	(t) => [uniqueIndex('tags_user_name_idx').on(t.userId, t.name)]
);

export const itemTags = sqliteTable(
	'item_tags',
	{
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		tagId: integer('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.itemId, t.tagId] }), index('item_tags_tag_idx').on(t.tagId)]
);

/** App-wide settings edited in the UI (e.g. API keys). Values here override the stack's env vars. */
export const appSettings = sqliteTable('app_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' })
});

export const providerCache = sqliteTable('provider_cache', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at').notNull()
});

export type User = typeof users.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type FieldDefinition = typeof fieldDefinitions.$inferSelect;
export type Item = typeof items.$inferSelect;
export type ItemLog = typeof itemLogs.$inferSelect;
export type Image = typeof images.$inferSelect;
