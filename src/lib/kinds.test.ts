import { describe, expect, it } from 'vitest';
import { KINDS, KIND_BY_KEY, LOG_SOURCES, keepHiddenKinds } from './kinds';
import { TEMPLATES, TEMPLATE_BY_KEY } from './server/templates';

describe('hidden MusicBrainz kinds', () => {
	it('are hidden but still known, so existing lists keep working', () => {
		const hidden = KINDS.filter((k) => k.hidden).map((k) => k.key);
		expect(hidden.sort()).toEqual(['musicbrainz:album', 'musicbrainz:artist']);
		expect(KIND_BY_KEY.has('musicbrainz:artist')).toBe(true);
	});

	it('the last.fm cards read plainly', () => {
		expect(KIND_BY_KEY.get('lastfm:album')?.label).toBe('Albums');
		expect(KIND_BY_KEY.get('lastfm:artist')?.label).toBe('Music artists');
	});

	it('saving keeps a hidden kind the list already had', () => {
		expect(keepHiddenKinds(['lastfm:album'], ['musicbrainz:album', 'lastfm:album'])).toEqual([
			'lastfm:album',
			'musicbrainz:album'
		]);
		expect(keepHiddenKinds([], ['musicbrainz:artist', 'tmdb:movie'])).toEqual(['musicbrainz:artist']);
		// never adds one the list did not have
		expect(keepHiddenKinds(['lastfm:album'], ['lastfm:album'])).toEqual(['lastfm:album']);
	});
});

describe('templates', () => {
	it('never offer MusicBrainz', () => {
		for (const t of TEMPLATES) expect(t.providerKinds.some((k) => k.startsWith('musicbrainz:'))).toBe(false);
	});

	it('albums use last.fm only; concerts use last.fm artists with setlists', () => {
		expect(TEMPLATE_BY_KEY.get('albums')?.providerKinds).toEqual(['lastfm:album']);
		expect(TEMPLATE_BY_KEY.get('concerts')?.providerKinds).toEqual(['lastfm:artist', 'setlistfm:setlist']);
	});

	it('setlists are offered for both artist kinds', () => {
		const forKinds: readonly string[] = LOG_SOURCES[0].forKinds;
		expect(forKinds).toContain('lastfm:artist');
		expect(forKinds).toContain('musicbrainz:artist');
	});
});
