CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`season` integer,
	`episode` integer,
	`title` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `releases_user_date_idx` ON `releases` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `releases_item_idx` ON `releases` (`item_id`);--> statement-breakpoint
ALTER TABLE `categories` ADD `show_in_calendar` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `releases_checked_at` integer;