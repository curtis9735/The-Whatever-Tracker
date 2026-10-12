-- setlist.fm lookups became a per-list option ("setlistfm:setlist" in provider_kinds).
-- Keep them on for existing concert lists: the Concerts template and any list of MusicBrainz artists.
UPDATE `categories`
SET `provider_kinds` = json_insert(`provider_kinds`, '$[#]', 'setlistfm:setlist')
WHERE (
		`template_key` = 'concerts'
		OR EXISTS (SELECT 1 FROM json_each(`categories`.`provider_kinds`) WHERE `value` = 'musicbrainz:artist')
	)
	AND NOT EXISTS (SELECT 1 FROM json_each(`categories`.`provider_kinds`) WHERE `value` = 'setlistfm:setlist');
