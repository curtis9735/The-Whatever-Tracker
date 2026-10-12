import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-artist-images-'));
	return {
		env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), MUSICBRAINZ_CONTACT: 'test@example.com' }
	};
});

const { artistImage, commonsFileFromUrl, foldName, pickDeezerPicture, wikidataIdFromUrl } =
	await import('./providers/artist-images');

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const COMMONS_THUMB =
	'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Ed_Sheeran-6886_%28cropped%29.jpg/500px-Ed_Sheeran-6886_%28cropped%29.jpg';
const DEEZER_PIC =
	'https://cdn-images.dzcdn.net/images/artist/d6bb84390641d8ae9118228d9544e53d/500x500-000000-80-0-0.jpg';

/** Answers like the real services, by host. */
function fakeWeb(opts: { wikidataFile?: string; deezer?: unknown[]; down?: string[] } = {}) {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			calls.push(url.host);
			if (opts.down?.includes(url.host)) throw new TypeError('fetch failed');
			if (url.host === 'www.wikidata.org') {
				const file = opts.wikidataFile;
				return json({ claims: file ? { P18: [{ mainsnak: { datavalue: { value: file } } }] } : {} });
			}
			if (url.host === 'commons.wikimedia.org') {
				expect(url.searchParams.get('titles')).toMatch(/^File:/);
				return json({
					query: { pages: { '1': { imageinfo: [{ thumburl: `${COMMONS_THUMB}?utm_source=x` }] } } }
				});
			}
			if (url.host === 'api.deezer.com') return json({ data: opts.deezer ?? [] });
			throw new Error(`unexpected ${url}`);
		})
	);
	return calls;
}

describe('artist photos', () => {
	it('reads the ids MusicBrainz links to', () => {
		expect(wikidataIdFromUrl('https://www.wikidata.org/wiki/Q47447')).toBe('Q47447');
		expect(wikidataIdFromUrl('https://example.com/Q1')).toBeUndefined();
		expect(commonsFileFromUrl('https://commons.wikimedia.org/wiki/File:Ed_Sheeran_2013.jpg')).toBe(
			'Ed_Sheeran_2013.jpg'
		);
		expect(commonsFileFromUrl('https://commons.wikimedia.org/wiki/File:Beyonc%C3%A9.jpg')).toBe(
			'Beyoncé.jpg'
		);
	});

	it('matches Deezer artists by exact name, most fans first, skipping blank pictures', () => {
		expect(foldName('Beyoncé!')).toBe(foldName('beyonce'));
		const pic = pickDeezerPicture(
			[
				{ name: 'Ed Sheeran Piano Covers', nb_fan: 300, picture_big: 'https://x/covers.jpg' },
				{ name: 'Ed Sheeran', nb_fan: 5, picture_big: 'https://x/images/artist//500x500.jpg' },
				{ name: 'ed sheeran', nb_fan: 20_000_000, picture_big: DEEZER_PIC },
				{ name: 'Ed Sheeran', nb_fan: 10, picture_big: 'https://x/other.jpg' }
			],
			'Ed Sheeran'
		);
		expect(pic).toBe(DEEZER_PIC);
	});

	it("uses Wikidata's image for the artist when MusicBrainz links one", async () => {
		const calls = fakeWeb({ wikidataFile: 'Ed Sheeran-6886 (cropped).jpg' });
		const url = await artistImage({
			id: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6',
			name: 'Ed Sheeran',
			relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q47447' } }]
		});
		expect(url).toBe(COMMONS_THUMB);
		expect(calls).toEqual(['www.wikidata.org', 'commons.wikimedia.org']);
	});

	it('falls back to Deezer, and remembers the answer', async () => {
		const calls = fakeWeb({ deezer: [{ name: 'Ed Sheeran', nb_fan: 1, picture_big: DEEZER_PIC }] });
		const artist = { id: '00000000-0000-0000-0000-000000000001', name: 'Ed Sheeran', relations: [] };
		expect(await artistImage(artist)).toBe(DEEZER_PIC);
		expect(await artistImage(artist)).toBe(DEEZER_PIC);
		expect(calls).toEqual(['api.deezer.com']);
	});

	it("gives up quietly, and doesn't remember an outage as 'no photo'", async () => {
		const artist = { id: '00000000-0000-0000-0000-000000000002', name: 'Somebody' };
		fakeWeb({ down: ['api.deezer.com'] });
		expect(await artistImage(artist)).toBeNull();
		const calls = fakeWeb({ deezer: [{ name: 'Somebody', picture_big: DEEZER_PIC }] });
		expect(await artistImage(artist)).toBe(DEEZER_PIC);
		expect(calls).toEqual(['api.deezer.com']);
	});
});
