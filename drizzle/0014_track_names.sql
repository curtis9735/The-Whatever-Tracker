ALTER TABLE `lastfm_accounts` ADD `names_at` integer;--> statement-breakpoint
ALTER TABLE `lastfm_scrobbles` ADD `track` text;--> statement-breakpoint
-- Connected accounts that already imported get their one-time name re-read started at the next pass
UPDATE `lastfm_accounts` SET `next_sync_at` = 0 WHERE `backfilled_at` IS NOT NULL AND `error_code` IS NULL AND `job` IS NULL;