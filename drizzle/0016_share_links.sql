CREATE TABLE `share_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_viewed_at` integer,
	`view_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_idx` ON `share_links` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_active_idx` ON `share_links` (`category_id`) WHERE revoked_at IS NULL;