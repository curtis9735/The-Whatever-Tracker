CREATE TABLE `checkins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`season` integer,
	`episode` integer,
	`episode_title` text,
	`checked_in_at` integer NOT NULL,
	`date` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`runtime_known` integer DEFAULT false NOT NULL,
	`ends_at` integer NOT NULL,
	`paused_at` integer,
	`status_before` text,
	`status_set` text,
	`ended_at` integer,
	`outcome` text,
	`log_id` integer,
	`watch_id` integer,
	`status_after` text,
	`status_final` text,
	`undo_status` text,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`log_id`) REFERENCES `item_logs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkins_live_user_idx` ON `checkins` (`user_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX `checkins_live_ends_idx` ON `checkins` (`ends_at`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX `checkins_item_idx` ON `checkins` (`item_id`);--> statement-breakpoint
CREATE INDEX `checkins_user_ended_idx` ON `checkins` (`user_id`,`ended_at`);