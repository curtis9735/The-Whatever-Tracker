import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setlists-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), SETLISTFM_API_KEY: 'test-key' } };
});

const { searchSetlists, setlistSearchUrl } = await import('./providers/setlistfm');
const { listUsesSetlists, setlistArtist } = await import('./services/concerts');
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

describe('rate limiting', () => {
	it('waits and retries once when setlist.fm answers 429', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				++calls === 1
					? new Response('{"code":429}', { status: 429 })
					: new Response(JSON.stringify(edSheeranIndy), { status: 200 })
			)
		);
		const { events } = await searchSetlists({ artist: { name: 'Ed Sheeran' }, year: '2026' });
		expect(calls).toBe(2);
		expect(events[0].venue).toBe('Lucas Oil Stadium');
	}, 15_000);
});

describe('which lists look up setlists', () => {
	const base = { provider: null, providerKind: null, providerId: null, title: 'Ed Sheeran' };

	it('is a per-list switch', () => {
		expect(listUsesSetlists({ providerKinds: ['musicbrainz:artist', 'setlistfm:setlist'] })).toBe(true);
		expect(listUsesSetlists({ providerKinds: ['musicbrainz:artist'] })).toBe(false);
		expect(listUsesSetlists({ providerKinds: [] })).toBe(false);
	});

	it('searches hand-added artists by name, and MusicBrainz artists exactly', () => {
		expect(setlistArtist(base as never)).toEqual({ name: 'Ed Sheeran' });
		const linked = {
			...base,
			provider: 'musicbrainz',
			providerKind: 'artist',
			providerId: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6'
		};
		expect(setlistArtist(linked as never)).toEqual({ mbid: 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6' });
	});

	it('the upgrade turns it on for existing concert lists only (and only once)', () => {
		const sqlite = rawDb();
		const user = sqlite
			.prepare(
				"INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('mig', 'mig', 'x', 0)"
			)
			.run().lastInsertRowid;
		const add = (slug: string, kinds: string[], template: string | null) =>
			sqlite
				.prepare(
					`INSERT INTO categories (user_id, name, slug, statuses, provider_kinds, template_key, created_at)
					 VALUES (?, ?, ?, '[]', ?, ?, 0)`
				)
				.run(user, slug, slug, JSON.stringify(kinds), template);
		add('concerts', ['musicbrainz:artist'], 'concerts');
		add('gigs', ['musicbrainz:artist'], null);
		add('renamed-concerts', [], 'concerts');
		add('albums', ['musicbrainz:album'], 'albums');
		add('cheese', [], 'cheese');

		const migration = fs.readFileSync(path.resolve('drizzle/0003_concert_setlists.sql'), 'utf8');
		sqlite.exec(migration);
		sqlite.exec(migration); // running twice must not add it twice

		const kinds = Object.fromEntries(
			(
				sqlite.prepare('SELECT slug, provider_kinds FROM categories WHERE user_id = ?').all(user) as {
					slug: string;
					provider_kinds: string;
				}[]
			).map((r) => [r.slug, JSON.parse(r.provider_kinds)])
		);
		expect(kinds).toEqual({
			concerts: ['musicbrainz:artist', 'setlistfm:setlist'],
			gigs: ['musicbrainz:artist', 'setlistfm:setlist'],
			'renamed-concerts': ['setlistfm:setlist'],
			albums: ['musicbrainz:album'],
			cheese: []
		});
	});
});
