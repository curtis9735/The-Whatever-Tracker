-- Full-text index for local search. rowid = items.id; rows are (re)built by the app
-- whenever an item, its tags, or its logs change (see src/lib/server/search/local.ts).
CREATE VIRTUAL TABLE `items_fts` USING fts5(
	`title`,
	`subtitle`,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
CREATE TRIGGER `items_fts_delete` AFTER DELETE ON `items` BEGIN
	DELETE FROM `items_fts` WHERE rowid = old.id;
END;
