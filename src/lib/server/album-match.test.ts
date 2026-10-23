import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const {
	albumKey,
	artistOfItem,
	emptyAlbumIndex,
	findAlbumItem,
	foldAlbum,
	foldArtist,
	indexAdd,
	lastfmAlbumId,
	lastfmArtistId,
	parseLastfmAlbumId,
	parseLastfmArtistId
} = await import('./album-match');

describe('foldArtist', () => {
	it('removes feat. credits', () => {
		expect(foldArtist('Daft Punk feat. Pharrell Williams')).toBe('daft punk');
		expect(foldArtist('Daft Punk (ft. Pharrell Williams)')).toBe('daft punk');
		expect(foldArtist('Daft Punk featuring Pharrell')).toBe('daft punk');
		expect(foldArtist('Daft Punk [feat. Pharrell]')).toBe('daft punk');
	});

	it('treats & and "and" as the same', () => {
		expect(foldArtist('Simon & Garfunkel')).toBe(foldArtist('Simon and Garfunkel'));
	});

	it('folds case, diacritics and punctuation', () => {
		expect(foldArtist('Beyoncé')).toBe(foldArtist('BEYONCE'));
		expect(foldArtist('Sigur Rós')).toBe('sigur ros');
	});
});

describe('foldAlbum', () => {
	it('keeps editions distinct', () => {
		expect(foldAlbum('OK Computer (Deluxe Edition)')).not.toBe(foldAlbum('OK Computer'));
		expect(albumKey('Radiohead', 'OK Computer (Deluxe Edition)')).not.toBe(
			albumKey('Radiohead', 'OK Computer')
		);
	});

	it('still ignores case and punctuation', () => {
		expect(foldAlbum('Ok  Computer!')).toBe(foldAlbum('OK Computer'));
	});
});

describe('artistOfItem', () => {
	it('falls back from metadata.artist to the Artist fact to the subtitle to null', () => {
		const facts = [{ label: 'Artist', value: 'From Facts' }];
		expect(artistOfItem({ subtitle: 'Sub · 1997', metadata: { artist: 'From Meta', facts } })).toBe(
			'From Meta'
		);
		expect(artistOfItem({ subtitle: 'Sub · 1997', metadata: { facts } })).toBe('From Facts');
		expect(artistOfItem({ subtitle: 'Radiohead · 1997 · Album', metadata: {} })).toBe('Radiohead');
		expect(artistOfItem({ subtitle: null, metadata: null })).toBeNull();
	});
});

describe('findAlbumItem', () => {
	const item = (id: number, title: string, subtitle: string | null, extra = {}) => ({
		id,
		title,
		subtitle,
		metadata: null,
		...extra
	});

	it('matches by provider id, then by artist and title', () => {
		const ix = emptyAlbumIndex();
		const pid = lastfmAlbumId('Radiohead', 'Kid A');
		indexAdd(
			ix,
			item(1, 'Kid A', 'Radiohead', { provider: 'lastfm', providerKind: 'album', providerId: pid })
		);
		indexAdd(ix, item(2, 'OK Computer', 'Radiohead · 1997 · Album'));
		expect(findAlbumItem(ix, 'Someone else', 'Other', pid)).toBe(1);
		expect(findAlbumItem(ix, 'RADIOHEAD', 'ok computer')).toBe(2);
		expect(findAlbumItem(ix, 'Radiohead', 'OK Computer (Deluxe Edition)')).toBeNull();
	});

	it('matches by title only for an item with no artist, when the title is unique', () => {
		const ix = emptyAlbumIndex();
		indexAdd(ix, item(1, 'In Rainbows', null));
		indexAdd(ix, item(2, 'Hits', null));
		indexAdd(ix, item(3, 'Hits', null));
		indexAdd(ix, item(4, 'Up', null));
		expect(findAlbumItem(ix, 'Radiohead', 'In Rainbows')).toBe(1);
		// Two items share the title
		expect(findAlbumItem(ix, 'Anyone', 'Hits')).toBeNull();
		// Too short to trust
		expect(findAlbumItem(ix, 'Anyone', 'Up')).toBeNull();
	});

	it('does not title-match an item that has an artist', () => {
		const ix = emptyAlbumIndex();
		indexAdd(ix, item(1, 'In Rainbows', 'Radiohead'));
		expect(findAlbumItem(ix, 'Someone Else', 'In Rainbows')).toBeNull();
	});
});

describe('last.fm ids', () => {
	it('round-trips unicode and slashes', () => {
		const id = lastfmAlbumId('AC/DC', 'Back in Black / 背徳 ♥');
		expect(id).toMatch(/^[\w-]+$/);
		expect(parseLastfmAlbumId(id)).toEqual({ artist: 'AC/DC', title: 'Back in Black / 背徳 ♥' });
		expect(parseLastfmArtistId(lastfmArtistId('Sigur Rós'))).toBe('Sigur Rós');
	});

	it('stays within 400 characters for long names', () => {
		const id = lastfmAlbumId('a'.repeat(150), 'b'.repeat(150));
		expect(id.length).toBeLessThanOrEqual(400);
		expect(parseLastfmAlbumId(id)).not.toBeNull();
		const wide = lastfmAlbumId('é'.repeat(150), '背'.repeat(150));
		expect(wide.length).toBeLessThanOrEqual(400);
		expect(parseLastfmAlbumId(wide)).not.toBeNull();
	});

	it('rejects ids that are not ours', () => {
		expect(parseLastfmAlbumId('not valid!')).toBeNull();
		expect(parseLastfmAlbumId(lastfmArtistId('Radiohead'))).toBeNull();
		expect(parseLastfmArtistId(lastfmAlbumId('A', 'B'))).toBeNull();
	});
});
