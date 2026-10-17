CREATE TABLE `item_progress` (
	`item_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`status` text,
	`rating` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`notes` text,
	`last_logged_at` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `user_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_progress_user_idx` ON `item_progress` (`user_id`);--> statement-breakpoint
CREATE TABLE `list_shares` (
	`category_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'edit' NOT NULL,
	`show_up_next` integer DEFAULT true NOT NULL,
	`show_in_calendar` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`category_id`, `user_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_shares_user_idx` ON `list_shares` (`user_id`);--> statement-breakpoint
CREATE INDEX `images_path_idx` ON `images` (`path`);--> statement-breakpoint
CREATE INDEX `images_thumb_idx` ON `images` (`thumb_path`);