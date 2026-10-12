import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setlists-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), SETLISTFM_API_KEY: 'test-key' } };
});

const { searchSetlists, setlistSearchUrl } = await import('./providers/setlistfm');
const { isConcertItem, setlistArtist } = await import('./services/concerts');
const { rawDb } = await import('./db');

afterEach(() => vi.unstubAllGlobals());

// Trimmed copy of setlist.fm's answer for the example show
const edSheeranIndy = {
	type: 'setlists',
	itemsPerPage: 20,
	page: 1,
	total: 1,
	setlist: [
		{
			id: '1b41a998',
			eventDate: '10-10-2026',
			artist: { mbid: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6', name: 'Ed Sheeran' },
			venue: {
				name: 'Lucas Oil Stadium',
				city: { name: 'Indianapolis', stateCode: 'IN', country: { code: 'US', name: 'United States' } }
			},
			tour: { name: 'Loop Tour' },
			sets: { set: [{ song: [{ name: 'Castle on the Hill' }, { name: 'Shape of You' }] }] },
			url: 'https://www.setlist.fm/setlist/ed-sheeran/2026/lucas-oil-stadium-indianapolis-in-1b41a998.html'
		}
	]
};

describe('setlist.fm search', () => {
	it('searches by MusicBrainz ID, or by name for artists added by hand', () => {
		const byId = setlistSearchUrl({
			artist: { mbid: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6' },
			date: '2026-10-10'
		});
		expect(byId.searchParams.get('artistMbid')).toBe('b8a7c51f-362c-4dcb-a259-bc6e0095f0a6');
		expect(byId.searchParams.get('date')).toBe('10-10-2026');

		const byName = setlistSearchUrl({
			artist: { name: 'Ed Sheeran' },
			year: '2026',
			city: 'Indianapolis',
			venue: 'Lucas Oil Stadium'
		});
		expect(byName.searchParams.get('artistName')).toBe('Ed Sheeran');
		expect(byName.searchParams.get('year')).toBe('2026');
		expect(byName.searchParams.get('cityName')).toBe('Indianapolis');
		expect(byName.searchParams.get('venueName')).toBe('Lucas Oil Stadium');
	});

	it('returns the show with venue, city and songs', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(edSheeranIndy), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const { events } = await searchSetlists({ artist: { name: 'Ed Sheeran' }, date: '2026-10-10' });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			date: '2026-10-10',
			venue: 'Lucas Oil Stadium',
			city: 'Indianapolis, IN',
			tour: 'Loop Tour'
		});
		expect(events[0].songs.map((s) => s.name)).toEqual(['Castle on the Hill', 'Shape of You']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toContain('artistName=Ed+Sheeran');
		expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
	});

	it('caches "no setlist yet" only briefly, since fans add setlists after the show', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"code":404}', { status: 404 }))
		);
		const r = await searchSetlists({ artist: { name: 'Ed Sheeran' }, date: '2026-10-11' });
		expect(r).toEqual({ events: [], total: 0 });
		const row = rawDb()
			.prepare("SELECT expires_at FROM provider_cache WHERE key LIKE 'setlistfm:%date=11-10-2026%'")
			.get() as { expires_at: number };
		expect(row.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60_000);
	});
});

describe('which items can look up setlists', () => {
	const base = { provider: null, providerKind: null, providerId: null, title: 'Ed Sheeran' };
	const concerts = { providerKinds: ['musicbrainz:artist'], templateKey: 'concerts' };
	const cheese = { providerKinds: [], templateKey: 'cheese' };

	it('includes artists typed in by hand in a concerts list, searched by name', () => {
		expect(isConcertItem(base as never, concerts as never)).toBe(true);
		expect(setlistArtist(base as never)).toEqual({ name: 'Ed Sheeran' });
	});

	it('uses the exact MusicBrainz artist when there is one', () => {
		const linked = {
			...base,
			provider: 'musicbrainz',
			providerKind: 'artist',
			providerId: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6'
		};
		expect(isConcertItem(linked as never, cheese as never)).toBe(true);
		expect(setlistArtist(linked as never)).toEqual({ mbid: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6' });
	});

	it('leaves other lists alone', () => {
		expect(isConcertItem({ ...base, title: 'Brie' } as never, cheese as never)).toBe(false);
	});
});
