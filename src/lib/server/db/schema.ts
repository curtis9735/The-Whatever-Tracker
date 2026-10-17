import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { FieldScope, FieldType, ShareRole, StatusDef } from '$lib/types';

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
	/** Last time upcoming releases were looked up for this account */
	releasesCheckedAt: integer('releases_checked_at', { mode: 'timestamp_ms' }),
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
		/** Releases of this list's shows, movies and games appear in the Calendar */
		showInCalendar: integer('show_in_calendar', { mode: 'boolean' }).notNull().default(true),
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
		// A list's items for anyone it's shared with (items.user_id is its owner, not them)
		index('items_category_idx').on(t.categoryId),
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
	(t) => [
		index('images_item_idx').on(t.itemId),
		index('images_log_idx').on(t.logId),
		// Someone else's photo is served after finding which item it belongs to
		index('images_path_idx').on(t.path),
		index('images_thumb_idx').on(t.thumbPath)
	]
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

/**
 * Episodes watched of a show linked to TMDB: one row per play. A check-in made with a date has a log
 * (the date, rating and notes live there); "mark watched" without a date has none.
 */
export const episodeWatches = sqliteTable(
	'episode_watches',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		/** Deleting the log un-watches its episodes */
		logId: integer('log_id').references(() => itemLogs.id, { onDelete: 'cascade' }),
		/** 0 is TMDB's "Specials" */
		season: integer('season').notNull(),
		episode: integer('episode').notNull(),
		/** Episode name when it was watched */
		title: text('title'),
		/** YYYY-MM-DD, for plays without a log that still have a date (imported history) */
		watchedAt: text('watched_at'),
		createdAt: createdAt()
	},
	(t) => [
		index('episode_watches_item_idx').on(t.itemId, t.season, t.episode),
		index('episode_watches_log_idx').on(t.logId)
	]
);

/**
 * A list shared with someone else in the household. The list, its items, fields and photos stay the
 * owner's; each person keeps their own status, rating, favorites, notes, logs and episodes.
 */
export const listShares = sqliteTable(
	'list_shares',
	{
		categoryId: integer('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** 'edit' can add, change and remove items; 'view' only keeps their own progress */
		role: text('role').$type<ShareRole>().notNull().default('edit'),
		/** This person's own choice: the list's planned items in their Up next */
		showUpNext: integer('show_up_next', { mode: 'boolean' }).notNull().default(true),
		/** This person's own choice: the list's releases in their Calendar */
		showInCalendar: integer('show_in_calendar', { mode: 'boolean' }).notNull().default(true),
		createdAt: createdAt()
	},
	(t) => [primaryKey({ columns: [t.categoryId, t.userId] }), index('list_shares_user_idx').on(t.userId)]
);

/**
 * Someone's own progress on an item in a list shared with them. The owner's progress stays on the
 * item itself (items.status, rating…), so lists nobody else sees work exactly as before.
 */
export const itemProgress = sqliteTable(
	'item_progress',
	{
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		status: text('status'),
		/** 0–100 in tens, like items.rating */
		rating: integer('rating'),
		favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
		notes: text('notes'),
		lastLoggedAt: text('last_logged_at'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(t) => [primaryKey({ columns: [t.itemId, t.userId] }), index('item_progress_user_idx').on(t.userId)]
);

/** Air and release dates for items linked to TMDB or IGDB (TV episodes, movies, games), for the Calendar */
export const releases = sqliteTable(
	'releases',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<'episode' | 'movie' | 'game'>().notNull(),
		/** YYYY-MM-DD */
		date: text('date').notNull(),
		season: integer('season'),
		episode: integer('episode'),
		/** Episode name, when there is one */
		title: text('title')
	},
	(t) => [
		index('releases_user_date_idx').on(t.userId, t.date),
		index('releases_item_idx').on(t.itemId),
		// The Calendar shows releases of shared lists too, so it looks them up by date
		index('releases_date_idx').on(t.date)
	]
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
export type EpisodeWatch = typeof episodeWatches.$inferSelect;
export type ListShare = typeof listShares.$inferSelect;
export type ItemProgress = typeof itemProgress.$inferSelect;
