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
		/** null = written by hand; 'lastfm' = imported listening */
		source: text('source'),
		/** For 'lastfm': `${lastfm_albums.id}:${YYYY-MM-DD}`, so re-running an import updates the same log */
		sourceKey: text('source_key'),
		createdAt: createdAt()
	},
	(t) => [
		index('logs_item_idx').on(t.itemId),
		index('logs_user_date_idx').on(t.userId, t.date),
		// The journal reads days straight from these (covering, no log row needed): newest first across
		// everything, and per source (imported listening days, hand-written logs)
		index('logs_user_date_source_idx').on(t.userId, t.date, t.source, t.itemId),
		index('logs_user_source_date_idx').on(t.userId, t.source, t.date, t.itemId),
		// NULL sources never collide, so hand-written logs are unaffected
		uniqueIndex('logs_source_key_idx').on(t.userId, t.source, t.sourceKey)
	]
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

/**
 * "Watching now": a live check-in for a movie or an episode. It runs for the movie's or episode's
 * length, then the movie or episode is marked watched on its own. Each person has at most one live
 * (ended_at IS NULL); ended rows stay a while for the "Watched" card and its Undo.
 */
export const checkins = sqliteTable(
	'checkins',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		itemId: integer('item_id')
			.notNull()
			.references(() => items.id, { onDelete: 'cascade' }),
		/** Episodes only (null for a movie) */
		season: integer('season'),
		episode: integer('episode'),
		/** The episode's name at check-in, so finishing never needs TMDB */
		episodeTitle: text('episode_title'),
		/** All times below are ms since the epoch */
		checkedInAt: integer('checked_in_at').notNull(),
		/** YYYY-MM-DD: the check-in day, the date of the log it adds */
		date: text('date').notNull(),
		durationMs: integer('duration_ms').notNull(),
		/** The length came from TMDB (false: a usual length was assumed) */
		runtimeKnown: integer('runtime_known', { mode: 'boolean' }).notNull().default(false),
		/** When it finishes on its own; resuming after a pause moves it later */
		endsAt: integer('ends_at').notNull(),
		pausedAt: integer('paused_at'),
		/** The status at check-in, and the "active" status the check-in set (null: it didn't change it) */
		statusBefore: text('status_before'),
		statusSet: text('status_set'),
		/** Once it ends: null while live */
		endedAt: integer('ended_at'),
		/** 'finishing' while the play or log is being written, then 'auto' or 'early' */
		outcome: text('outcome').$type<'finishing' | 'auto' | 'early' | 'cancelled' | 'undone'>(),
		logId: integer('log_id').references(() => itemLogs.id, { onDelete: 'set null' }),
		/** episode_watches.id of the play it added (no foreign key: Undo or a delete may remove it) */
		watchId: integer('watch_id'),
		/** The status finishing changed it to, or null when finishing left it alone */
		statusAfter: text('status_after'),
		/** For Undo: the status right after finishing, and the one Undo puts back while it's still that */
		statusFinal: text('status_final'),
		undoStatus: text('undo_status'),
		/** The "Watched" card was closed */
		dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
		createdAt: createdAt()
	},
	(t) => [
		// One live check-in per person
		uniqueIndex('checkins_live_user_idx')
			.on(t.userId)
			.where(sql`ended_at IS NULL`),
		// The scheduler's look-up of check-ins whose time is up
		index('checkins_live_ends_idx')
			.on(t.endsAt)
			.where(sql`ended_at IS NULL`),
		index('checkins_item_idx').on(t.itemId),
		index('checkins_user_ended_idx').on(t.userId, t.endedAt)
	]
);

/** One person's last.fm connection: who they are on last.fm, where their albums go, and the sync's cursor */
export const lastfmAccounts = sqliteTable('lastfm_accounts', {
	userId: integer('user_id')
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	/** last.fm's own capitalization */
	username: text('username').notNull(),
	categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
	syncEvery: text('sync_every').$type<'hourly' | 'daily'>().notNull().default('hourly'),
	journalMode: text('journal_mode').$type<'group' | 'hide' | 'all'>().notNull().default('group'),
	/** Every play at or before this (unix seconds) is imported */
	syncedUntil: integer('synced_until').notNull().default(0),
	/** The running window: plays from jobFrom (exclusive) up to jobEnd, newest first, jobTo is the cursor */
	job: text('job').$type<'backfill' | 'sync'>(),
	jobFrom: integer('job_from'),
	jobTo: integer('job_to'),
	jobEnd: integer('job_end'),
	jobTotal: integer('job_total'),
	jobDone: integer('job_done').notNull().default(0),
	backfilledAt: integer('backfilled_at', { mode: 'timestamp_ms' }),
	lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
	/** ms since the epoch: when a sync last re-read the full two-week window for late-submitted plays */
	deepSyncAt: integer('deep_sync_at').notNull().default(0),
	/** ms since the epoch: when the next sync (or retry) is due */
	nextSyncAt: integer('next_sync_at').notNull().default(0),
	errorCode: text('error_code'),
	errorMessage: text('error_message'),
	errorCount: integer('error_count').notNull().default(0),
	/** Cached totals */
	plays: integer('plays').notNull().default(0),
	albums: integer('albums').notNull().default(0),
	/** The slow "fill in album details" pass finished */
	enrichedAt: integer('enriched_at', { mode: 'timestamp_ms' }),
	connectedAt: createdAt()
});

/** One row per person per album they've played */
export const lastfmAlbums = sqliteTable(
	'lastfm_albums',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** albumKey(artist, title) */
		key: text('key').notNull(),
		artist: text('artist').notNull(),
		title: text('title').notNull(),
		/** The last.fm username the plays came from; lets a different name be refused after "Stop syncing" */
		username: text('username'),
		mbid: text('mbid'),
		imageUrl: text('image_url'),
		/** The item it became (or matched); NULL once that item is deleted */
		itemId: integer('item_id').references(() => items.id, { onDelete: 'set null' }),
		/** Ever linked: a deleted item isn't re-added */
		linkedAt: integer('linked_at'),
		/** The import created the item */
		createdItem: integer('created_item', { mode: 'boolean' }).notNull().default(false),
		/** The import moved the person's status to done */
		promoted: integer('promoted', { mode: 'boolean' }).notNull().default(false),
		statusBefore: text('status_before'),
		plays: integer('plays').notNull().default(0),
		firstUts: integer('first_uts'),
		lastUts: integer('last_uts')
	},
	(t) => [
		uniqueIndex('lastfm_albums_user_key_idx').on(t.userId, t.key),
		index('lastfm_albums_user_mbid_idx').on(t.userId, t.mbid),
		index('lastfm_albums_item_idx').on(t.itemId)
	]
);

/** Every play. The key makes re-running a window harmless. */
export const lastfmScrobbles = sqliteTable(
	'lastfm_scrobbles',
	{
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Unix seconds */
		uts: integer('uts').notNull(),
		/** foldName(artist)|foldName(track) */
		trackKey: text('track_key').notNull(),
		albumId: integer('album_id')
			.notNull()
			.references(() => lastfmAlbums.id, { onDelete: 'cascade' }),
		/** YYYY-MM-DD in the server's time zone */
		date: text('date').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.uts, t.trackKey] }),
		index('lastfm_scrobbles_album_date_idx').on(t.albumId, t.date)
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
export type Checkin = typeof checkins.$inferSelect;
export type LastfmAccount = typeof lastfmAccounts.$inferSelect;
export type LastfmAlbum = typeof lastfmAlbums.$inferSelect;
