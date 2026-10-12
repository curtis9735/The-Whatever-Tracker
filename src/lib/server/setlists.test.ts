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
const { addLogWithShow, afterAddPath, listUsesSetlists, setlistArtist } = await import('./services/concerts');
const { createItem, getOwnedItem } = await import('./services/items');
const { getCategoryById } = await import('./services/categories');
const { setlistSections } = await import('$lib/setlists');
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

	it('shows state codes only where people use them', async () => {
		const munich = {
			...edSheeranIndy.setlist[0],
			eventDate: '31-08-2024',
			venue: {
				name: 'Sonderfreifläche Messe',
				city: { name: 'Munich', stateCode: '02', country: { code: 'DE', name: 'Germany' } }
			}
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response(JSON.stringify({ ...edSheeranIndy, setlist: [munich] }), { status: 200 })
			)
		);
		const { events } = await searchSetlists({ artist: { name: 'Adele' }, date: '2024-08-31' });
		expect(events[0].city).toBe('Munich');
		expect(events[0].country).toBe('Germany');
	}, 15_000);

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

describe('adding a concert saves the show with it', () => {
	const sqlite = rawDb();
	const user = Number(
		sqlite
			.prepare(
				"INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('fan', 'fan', 'x', 0)"
			)
			.run().lastInsertRowid
	);
	const statuses = [
		{ key: 'want', label: 'Want to see', group: 'planned' },
		{ key: 'seen', label: 'Seen', group: 'done' }
	];
	const catId = Number(
		sqlite
			.prepare(
				`INSERT INTO categories (user_id, name, slug, statuses, provider_kinds, created_at)
				 VALUES (?, 'Concerts', 'concerts', ?, ?, 0)`
			)
			.run(user, JSON.stringify(statuses), JSON.stringify(['musicbrainz:artist', 'setlistfm:setlist']))
			.lastInsertRowid
	);
	const category = () => getCategoryById(user, catId).category;
	let n = 0;
	const artist = () =>
		createItem(user, {
			categoryId: catId,
			title: 'Ed Sheeran',
			status: 'want',
			provider: 'musicbrainz',
			providerKind: 'artist',
			// Unique per test (one library entry per MusicBrainz artist)
			providerId: `b8a7c51f-362c-4dcb-a259-bc6e0095f${String(++n).padStart(3, '0')}`
		});
	const answer = (body: unknown, status = 200) =>
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(body), { status }))
		);

	it('attaches the one show that day: venue, city and setlist', async () => {
		answer(edSheeranIndy);
		const item = artist();
		const { log, show } = await addLogWithShow(user, item.id, category(), { date: '2026-10-10', rating: 90 });
		expect(show).toBe('attached');
		expect(log.location).toBe('Lucas Oil Stadium, Indianapolis, IN');
		expect(log.rating).toBe(90);
		const setlist = (log.external as { setlist: { songs: unknown[]; tour: string } }).setlist;
		expect(setlist.songs).toHaveLength(2);
		expect(setlist.tour).toBe('Loop Tour');
		// Logging a "Want to see" artist marks them Seen
		expect(getOwnedItem(user, item.id).status).toBe('seen');
		expect(afterAddPath(item.id, log.id, show)).toBe(`/items/${item.id}`);
	}, 15_000);

	it('keeps a venue the user typed', async () => {
		answer({ ...edSheeranIndy, setlist: [{ ...edSheeranIndy.setlist[0], eventDate: '09-10-2026' }] });
		const { log } = await addLogWithShow(user, artist().id, category(), {
			date: '2026-10-09',
			location: 'Section 112'
		});
		expect(log.location).toBe('Section 112');
		expect(log.external).toHaveProperty('setlist');
	}, 15_000);

	it('still saves the date when setlist.fm has nothing yet', async () => {
		answer({ code: 404 }, 404);
		const item = artist();
		const { log, show } = await addLogWithShow(user, item.id, category(), { date: '2026-10-08' });
		expect(show).toBe('none');
		expect(log.date).toBe('2026-10-08');
		expect(log.external).toBeNull();
		expect(afterAddPath(item.id, log.id, show)).toBe(`/items/${item.id}`);
	}, 15_000);

	it('sends the user to pick when there were several shows that day', async () => {
		const two = { ...edSheeranIndy.setlist[0], eventDate: '07-10-2026' };
		answer({ ...edSheeranIndy, total: 2, setlist: [two, { ...two, id: '2b41a998' }] });
		const item = artist();
		const { log, show } = await addLogWithShow(user, item.id, category(), { date: '2026-10-07' });
		expect(show).toBe('several');
		expect(log.external).toBeNull();
		expect(afterAddPath(item.id, log.id, show)).toBe(`/logs/${log.id}/edit?pick=1`);
	}, 15_000);

	it('saves the log and warns when setlist.fm is unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		const item = artist();
		const { log, show } = await addLogWithShow(user, item.id, category(), { date: '2026-10-06' });
		expect(show).toBe('failed');
		expect(log.date).toBe('2026-10-06');
		expect(afterAddPath(item.id, log.id, show)).toContain('warn=');
	}, 15_000);

	it('does not touch setlist.fm for other lists', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { show } = await addLogWithShow(
			user,
			artist().id,
			{ ...category(), providerKinds: [] },
			{
				date: '2026-10-05'
			}
		);
		expect(show).toBe('off');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('showing a setlist', () => {
	it('groups songs by set and numbers them straight through', () => {
		const sections = setlistSections([
			{ name: 'Castle on the Hill' },
			{ name: 'Shape of You' },
			{ name: 'Perfect', set: 'Encore' },
			{ name: 'Bad Habits', set: 'Encore' }
		]);
		expect(sections.map((s) => s.label)).toEqual([undefined, 'Encore']);
		expect(sections[1].songs.map((s) => [s.n, s.name])).toEqual([
			[3, 'Perfect'],
			[4, 'Bad Habits']
		]);
	});
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
