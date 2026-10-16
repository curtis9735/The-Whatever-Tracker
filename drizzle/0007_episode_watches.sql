CREATE TABLE `episode_watches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`log_id` integer,
	`season` integer NOT NULL,
	`episode` integer NOT NULL,
	`title` text,
	`watched_at` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`log_id`) REFERENCES `item_logs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `episode_watches_item_idx` ON `episode_watches` (`item_id`,`season`,`episode`);--> statement-breakpoint
CREATE INDEX `episode_watches_log_idx` ON `episode_watches` (`log_id`);