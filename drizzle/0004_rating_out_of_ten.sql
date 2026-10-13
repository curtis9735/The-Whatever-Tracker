-- Every rating is now a whole number out of 10 (stored as tens), and lists no longer have a scale.
-- Existing ratings keep their meaning: 4.5 stars (90) becomes 9/10, 85/100 becomes 9/10, 7.5/10 becomes 8/10.
UPDATE `items` SET `rating` = CAST(ROUND(`rating` / 10.0) AS INTEGER) * 10 WHERE `rating` IS NOT NULL;
--> statement-breakpoint
UPDATE `item_logs` SET `rating` = CAST(ROUND(`rating` / 10.0) AS INTEGER) * 10 WHERE `rating` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `categories` DROP COLUMN `rating_scale`;
