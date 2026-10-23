CREATE TABLE `lastfm_accounts` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`category_id` integer,
	`sync_every` text DEFAULT 'hourly' NOT NULL,
	`journal_mode` text DEFAULT 'group' NOT NULL,
	`synced_until` integer DEFAULT 0 NOT NULL,
	`job` text,
	`job_from` integer,
	`job_to` integer,
	`job_end` integer,
	`job_total` integer,
	`job_done` integer DEFAULT 0 NOT NULL,
	`backfilled_at` integer,
	`last_sync_at` integer,
	`deep_sync_at` integer DEFAULT 0 NOT NULL,
	`next_sync_at` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`plays` integer DEFAULT 0 NOT NULL,
	`albums` integer DEFAULT 0 NOT NULL,
	`enriched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `lastfm_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`key` text NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`mbid` text,
	`image_url` text,
	`item_id` integer,
	`linked_at` integer,
	`created_item` integer DEFAULT false NOT NULL,
	`promoted` integer DEFAULT false NOT NULL,
	`status_before` text,
	`plays` integer DEFAULT 0 NOT NULL,
	`first_uts` integer,
	`last_uts` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lastfm_albums_user_key_idx` ON `lastfm_albums` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `lastfm_albums_user_mbid_idx` ON `lastfm_albums` (`user_id`,`mbid`);--> statement-breakpoint
CREATE INDEX `lastfm_albums_item_idx` ON `lastfm_albums` (`item_id`);--> statement-breakpoint
CREATE TABLE `lastfm_scrobbles` (
	`user_id` integer NOT NULL,
	`uts` integer NOT NULL,
	`track_key` text NOT NULL,
	`album_id` integer NOT NULL,
	`date` text NOT NULL,
	PRIMARY KEY(`user_id`, `uts`, `track_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`album_id`) REFERENCES `lastfm_albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lastfm_scrobbles_album_date_idx` ON `lastfm_scrobbles` (`album_id`,`date`);--> statement-breakpoint
ALTER TABLE `item_logs` ADD `source` text;--> statement-breakpoint
ALTER TABLE `item_logs` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `logs_source_key_idx` ON `item_logs` (`user_id`,`source`,`source_key`);