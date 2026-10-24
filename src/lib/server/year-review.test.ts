import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-year-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, rawDb, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { saveShares, leaveList } = await import('./services/access');
const { addLog, createItem } = await import('./services/items');
const { insertWatches } = await import('./services/episodes');
const { reviewYears, yearInReview } = await import('./services/year');

const TODAY = '2026-10-14';

function person(name: string) {
	const user = db()
		.insert(schema.users)
		.values({ username: name, displayName: name, passwordHash: 'x' })
		.returning()
		.get();
	const lists = {
		whiskey: createCategoryFromTemplate(user.id, 'whiskey'),
		concerts: createCategoryFromTemplate(user.id, 'concerts'),
		movies: createCategoryFromTemplate(user.id, 'movies'),
		tv: createCategoryFromTemplate(user.id, 'tv-shows'),
		albums: createCategoryFromTemplate(user.id, 'albums')
	};
	/** An item of the list (made once per title), with a log on `date` */
	const items = new Map<string, number>();
	const log = (
		catId: number,
		title: string,
		date: string,
		extra: Record<string, unknown> = {},
		item: Record<string, unknown> = {}
	) => {
		const k = `${catId}:${title}`;
		if (!items.has(k)) items.set(k, createItem(user.id, { categoryId: catId, title, ...item }).id);
		const id = items.get(k)!;
		const { category } = getCategoryById(user.id, catId);
		return { itemId: id, log: addLog(user.id, id, { date, ...extra }, category.statuses) };
	};
	return { user, lists, log, items };
}

/** An album, as the importer leaves it: an item (optionally with a cover) and its last.fm row */
function album(userId: number, catId: number, title: string, artist: string, cover = false) {
	const item = createItem(userId, { categoryId: catId, title });
	if (cover) {
		const img = rawDb()
			.prepare(
				`INSERT INTO images (user_id, item_id, kind, source_url, sort_order, created_at)
				 VALUES (?, ?, 'url_link', ?, 0, 1) RETURNING id`
			)
			.get(userId, item.id, `https://img.example/${title}.png`) as { id: number };
		rawDb().prepare('UPDATE items SET cover_image_id = ? WHERE id = ?').run(img.id, item.id);
	}
	const a = rawDb()
		.prepare(
			`INSERT INTO lastfm_albums (user_id, key, artist, title, item_id) VALUES (?, ?, ?, ?, ?) RETURNING id`
		)
		.get(userId, `${artist}|${title}`, artist, title, item.id) as { id: number };
	return { itemId: item.id, albumId: a.id };
}

let uts = 1_000_000;
function scrobbles(
	userId: number,
	albumId: number,
	artist: string,
	track: string | null,
	date: string,
	n: number
) {
	const insert = rawDb().prepare(
		'INSERT INTO lastfm_scrobbles (user_id, uts, track_key, album_id, date, track) VALUES (?, ?, ?, ?, ?, ?)'
	);
	for (let i = 0; i < n; i++) {
		insert.run(
			userId,
			uts++,
			`${artist.toLowerCase()}|${(track ?? 'unnamed').toLowerCase()}`,
			albumId,
			date,
			track
		);
	}
}

/** A day of imported listening on an album, as the importer writes it */
function listened(userId: number, itemId: number, date: string, plays: number) {
	rawDb()
		.prepare(
			`INSERT INTO item_logs (item_id, user_id, date, custom, external, source, source_key, created_at)
			 VALUES (?, ?, ?, '{}', ?, 'lastfm', ?, 1)`
		)
		.run(itemId, userId, date, JSON.stringify({ lastfm: { plays } }), `${itemId}:${date}`);
}

/** TMDB's answers are saved (even long ago); nothing is fetched */
const cacheTmdb = (key: string, value: unknown) =>
	rawDb()
		.prepare('INSERT OR REPLACE INTO provider_cache (key, value, expires_at) VALUES (?, ?, ?)')
		.run(key, JSON.stringify(value), 1);

let tmdbId = 1000;
const movie = (runtime: string | null) => ({
	provider: 'tmdb',
	providerKind: 'movie',
	providerId: String(tmdbId++),
	metadata: runtime ? { facts: [{ label: 'Runtime', value: runtime }] } : null
});

const rate = (n: number) => ({ rating: n });

describe('year in review', () => {
	const d = person('daniel');
	const partner = person('partner');

	// Whiskey: Lagavulin was already logged in 2025, at The Snug
	d.log(d.lists.whiskey.id, 'Lagavulin 16', '2025-11-20', { location: 'The Snug' });
	d.log(d.lists.whiskey.id, 'Lagavulin 16', '2026-01-05', { ...rate(90), location: 'the snug ' });
	d.log(d.lists.whiskey.id, 'Talisker 10', '2026-01-06', { ...rate(70), location: 'Home' });
	d.log(d.lists.whiskey.id, 'Talisker 10', '2026-01-07', { location: 'Home' });
	d.log(d.lists.whiskey.id, 'Ardbeg 10', '2026-03-15');
	// Concerts: Old Band was seen in 2025 too
	d.log(d.lists.concerts.id, 'Old Band', '2025-05-02');
	d.log(d.lists.concerts.id, 'Ed Sheeran', '2026-06-10', { location: 'Lucas Oil Stadium' });
	d.log(d.lists.concerts.id, 'Old Band', '2026-07-04');
	// Movies: one with a known length, one without (rewatched)
	d.log(d.lists.movies.id, 'Heat', '2026-02-01', rate(80), movie('2h 50m'));
	d.log(d.lists.movies.id, 'Mystery Movie', '2026-02-01', rate(60), movie(null));
	d.log(d.lists.movies.id, 'Mystery Movie', '2026-02-14', rate(60));

	// TV: show 99 has a saved season (episode 3 isn't in it) and a saved latest-episode length; show 100 nothing
	cacheTmdb('tmdb:tv-season:99:1', {
		season_number: 1,
		episodes: [
			{ episode_number: 1, runtime: 40 },
			{ episode_number: 2, runtime: 50 }
		]
	});
	cacheTmdb('tmdb:tv-air:99', { last_episode_to_air: { season_number: 1, episode_number: 3, runtime: 55 } });
	const show99 = d.log(
		d.lists.tv.id,
		'Show 99',
		'2026-02-02',
		{},
		{ provider: 'tmdb', providerKind: 'tv', providerId: '99' }
	);
	const show100 = createItem(d.user.id, {
		categoryId: d.lists.tv.id,
		title: 'Show 100',
		provider: 'tmdb',
		providerKind: 'tv',
		providerId: '100'
	});
	rawDb()
		.prepare(
			'INSERT INTO episode_watches (user_id, item_id, log_id, season, episode, created_at) VALUES (?, ?, ?, 1, 1, 1)'
		)
		.run(d.user.id, show99.itemId, show99.log.id);
	insertWatches(d.user.id, show99.itemId, [
		{ season: 1, episode: 2, watchedAt: '2026-02-03' },
		{ season: 1, episode: 3, watchedAt: '2026-02-03' },
		{ season: 2, episode: 1, watchedAt: '2025-12-31' } // last year
	]);
	insertWatches(d.user.id, show99.itemId, [{ season: 3, episode: 1 }]); // no date at all
	insertWatches(d.user.id, show100.id, [{ season: 1, episode: 1, watchedAt: '2026-03-01' }]);

	// Music
	const alpha = album(d.user.id, d.lists.albums.id, 'Alpha', 'Band X', true);
	const beta = album(d.user.id, d.lists.albums.id, 'Beta', 'Band Y');
	const charlie = album(d.user.id, d.lists.albums.id, 'Charlie', 'band x');
	const delta = album(d.user.id, d.lists.albums.id, 'Delta', 'Band Z');
	scrobbles(d.user.id, alpha.albumId, 'Band X', 'Song 1', '2025-12-30', 1);
	scrobbles(d.user.id, alpha.albumId, 'Band X', 'Song 1', '2026-04-10', 4);
	scrobbles(d.user.id, alpha.albumId, 'Band X', 'Song 2', '2026-04-10', 1);
	scrobbles(d.user.id, beta.albumId, 'Band Y', 'Song 3', '2026-04-10', 3);
	scrobbles(d.user.id, alpha.albumId, 'Band X', 'Song 1', '2026-04-11', 2);
	scrobbles(d.user.id, charlie.albumId, 'Band X', 'Song 4', '2026-05-01', 1);
	scrobbles(d.user.id, delta.albumId, 'Band Z', null, '2026-05-01', 3);
	listened(d.user.id, alpha.itemId, '2025-12-30', 1);
	listened(d.user.id, alpha.itemId, '2026-04-10', 5);
	listened(d.user.id, beta.itemId, '2026-04-10', 3);
	listened(d.user.id, alpha.itemId, '2026-04-11', 2);

	// Someone else, in the same database
	partner.log(partner.lists.whiskey.id, 'Partner Bottle', '2026-01-05', rate(100));
	const pa = album(partner.user.id, partner.lists.albums.id, 'Partner Album', 'Partner Band');
	scrobbles(partner.user.id, pa.albumId, 'Partner Band', 'Partner Song', '2026-04-10', 50);
	listened(partner.user.id, pa.itemId, '2026-04-10', 50);

	const r = yearInReview(d.user.id, 2026, TODAY);

	it('knows which years have anything, newest first', () => {
		expect(reviewYears(d.user.id, TODAY)).toEqual([2026, 2025]);
		expect(reviewYears(person('nobody').user.id, TODAY)).toEqual([]);
	});

	it('counts years of episodes with a date, and none still to come', () => {
		const binge = person('binge');
		const show = createItem(binge.user.id, { categoryId: binge.lists.tv.id, title: 'Old Show' });
		insertWatches(binge.user.id, show.id, [{ season: 1, episode: 1, watchedAt: '2024-05-05' }]);
		binge.log(binge.lists.whiskey.id, 'Future bottle', '2027-02-02');
		expect(reviewYears(binge.user.id, TODAY)).toEqual([2024]);
		const y = yearInReview(binge.user.id, 2024, TODAY);
		expect(y.headline.logged).toBe(0);
		expect(y.watching).toMatchObject({ episodes: 1, movies: 0 });
	});

	it("shows only your own activity, never another person's", () => {
		expect(r.headline.logged).toBe(12);
		expect(JSON.stringify(r)).not.toContain('Partner');
		expect(r.music!.plays).toBe(14);
		// Their 50 plays and 100-rated bottle are theirs alone
		const theirs = yearInReview(partner.user.id, 2026, TODAY);
		expect(theirs.music!.plays).toBe(50);
		expect(theirs.headline.logged).toBe(2);
		expect(theirs.highlights.topRated).toMatchObject({ title: 'Partner Bottle', rating: 100 });
	});

	it('counts only your own logs on a list shared with you, and none once you leave it', () => {
		const owner = person('owner');
		const guest = person('guest');
		saveShares(owner.user.id, owner.lists.whiskey.id, [{ userId: guest.user.id, role: 'edit' }]);
		owner.log(owner.lists.whiskey.id, 'Shared Bottle', '2026-05-01', rate(90));
		owner.log(owner.lists.whiskey.id, 'Shared Bottle', '2026-05-02');
		const shared = owner.items.get(`${owner.lists.whiskey.id}:Shared Bottle`)!;
		const { category } = getCategoryById(guest.user.id, owner.lists.whiskey.id);
		addLog(guest.user.id, shared, { date: '2026-05-03' }, category.statuses);
		const mine = yearInReview(guest.user.id, 2026, TODAY);
		expect(mine.headline.logged).toBe(1);
		expect(mine.lists).toHaveLength(1);
		expect(mine.lists[0]).toMatchObject({ logs: 1, slug: 'whiskey@owner' });
		expect(mine.highlights.topRated).toBeNull(); // the owner's 90 is theirs
		expect(yearInReview(owner.user.id, 2026, TODAY).headline.logged).toBe(2);
		// Out of sight once they leave, as in the Journal
		leaveList(guest.user.id, owner.lists.whiskey.id);
		expect(yearInReview(guest.user.id, 2026, TODAY).headline.logged).toBe(0);
		expect(reviewYears(guest.user.id, TODAY)).toEqual([]);
	});

	it('counts a day of listening once, however much was played', () => {
		// 10 hand-written logs, and listening on two days (April 10 had two albums and 8 plays)
		expect(r.headline).toEqual({ logged: 12, activeDays: 11, lists: 5, newItems: 6, soFar: true });
		expect(r.months).toEqual([3, 4, 1, 2, 0, 1, 1, 0, 0, 0, 0, 0]);
	});

	it('knows when the year is still going', () => {
		expect(yearInReview(d.user.id, 2025, TODAY).headline.soFar).toBe(false);
		expect(yearInReview(d.user.id, 2025, '2026-01-02').headline.soFar).toBe(false);
		expect(yearInReview(d.user.id, 2026, '2026-12-31').headline.soFar).toBe(true);
	});

	it('finds the longest streak, the busiest month and day, and the best rated log', () => {
		const h = r.highlights;
		expect(h.longestStreak).toEqual({ from: '2026-01-05', to: '2026-01-07', days: 3 });
		expect(h.busiestMonth).toEqual({ month: 2, count: 4 });
		expect(h.busiestDay).toEqual({ date: '2026-02-01', count: 2 });
		expect(h.topRated).toMatchObject({
			title: 'Lagavulin 16',
			rating: 90,
			listName: 'Whiskey',
			date: '2026-01-05'
		});
		expect(h.first).toMatchObject({ title: 'Lagavulin 16', date: '2026-01-05' });
		expect(h.last).toMatchObject({ title: 'Old Band', date: '2026-07-04' });
	});

	it('knows which items, places and artists are new this year', () => {
		// Lagavulin and Old Band were logged in 2025; the other six items are new
		expect(r.headline.newItems).toBe(6);
		// The Snug (other case, trailing space) was used in 2025; Home and the stadium weren't
		expect(r.highlights.newPlaces).toBe(2);
		// Ed Sheeran (seen live), and Band Y and Band Z (first played this year); Band X was played in 2025
		expect(r.highlights.newArtists).toBe(3);
	});

	it('has a section per list, the busiest first, without last.fm music lists', () => {
		expect(r.lists.map((l) => `${l.name}:${l.logs}`)).toEqual([
			'Whiskey:4',
			'Movies:3',
			'Concerts:2',
			'TV Shows:1'
		]);
		const whiskey = r.lists[0];
		expect(whiskey).toMatchObject({ slug: 'whiskey', items: 3 });
		expect(whiskey.topRated.map((t) => `${t.title}:${t.rating}`)).toEqual([
			'Lagavulin 16:90',
			'Talisker 10:70'
		]);
		expect(whiskey.mostLogged.map((t) => `${t.title}:${t.count}`)).toEqual([
			'Talisker 10:2',
			'Ardbeg 10:1',
			'Lagavulin 16:1'
		]);
	});

	it('rates a list by the best log, falling back to the item itself', () => {
		const u = person('rater');
		u.log(u.lists.whiskey.id, 'Item rated', '2026-03-01', {}, { rating: 80 });
		u.log(u.lists.whiskey.id, 'Log rated', '2026-03-02', rate(90), { rating: 10 });
		u.log(u.lists.whiskey.id, 'Unrated', '2026-03-03');
		const top = yearInReview(u.user.id, 2026, TODAY).lists[0].topRated;
		expect(top.map((t) => `${t.title}:${t.rating}`)).toEqual(['Log rated:90', 'Item rated:80']);
	});

	it('counts what was watched, with approximate hours', () => {
		const w = r.watching!;
		// Heat, and Mystery Movie twice; three episodes of show 99 and one of show 100 dated this year
		expect(w.movies).toBe(3);
		expect(w.episodes).toBe(4);
		// 170 (known) + 120 + 120 (assumed) + 40 + 50 (saved season) + 55 (saved latest episode) + 45 (assumed)
		expect(w.minutes).toBe(600);
		expect(w.hours).toBe(10);
		expect(w.approximate).toBe(true);
		expect(w.topShow).toMatchObject({ title: 'Show 99', count: 3 });
		expect(w.topMovies.map((t) => `${t.title}:${t.rating}`)).toEqual(['Heat:80', 'Mystery Movie:60']);
		// Two movies on Feb 1, two episodes on Feb 3
		expect(w.busiestDay).toEqual({ date: '2026-02-01', count: 2 });
	});

	it('is not approximate when every length is known', () => {
		const u = person('exact');
		u.log(u.lists.movies.id, 'Known', '2026-02-01', {}, movie('1h 30m'));
		expect(yearInReview(u.user.id, 2026, TODAY).watching).toMatchObject({ minutes: 90, approximate: false });
	});

	it('has no watching or music section without any', () => {
		const u = person('reader');
		u.log(u.lists.whiskey.id, 'Just a drink', '2026-01-01');
		const y = yearInReview(u.user.id, 2026, TODAY);
		expect(y.watching).toBeNull();
		expect(y.music).toBeNull();
	});

	it('sums up the music', () => {
		const m = r.music!;
		expect(m).toMatchObject({ plays: 14, tracks: 5, albums: 4, artists: 3 });
		expect(m.biggestDay).toEqual({ date: '2026-04-10', plays: 8 });
		expect(m.busiestMonth).toEqual({ month: 4, plays: 10 });
		expect(m.topAlbums.map((a) => `${a.title}:${a.plays}`)).toEqual([
			'Alpha:7',
			'Beta:3',
			'Delta:3',
			'Charlie:1'
		]);
		expect(m.topAlbums[0]).toMatchObject({ itemId: alpha.itemId, artist: 'Band X' });
		expect(m.topAlbums[0].coverUrl).toContain('Alpha');
		expect(m.topAlbums[1].coverUrl).toBeNull();
		// "Band X" and "band x" are one artist
		expect(m.topArtists.map((a) => `${a.artist}:${a.plays}`)).toEqual(['Band X:8', 'Band Y:3', 'Band Z:3']);
		expect(m.topArtists[0].albums).toBe(2);
		// Plays with no track name (stored before names were kept) aren't listed
		expect(m.topTracks.map((t) => `${t.name}:${t.plays}`)).toEqual([
			'Song 1:6',
			'Song 3:3',
			'Song 2:1',
			'Song 4:1'
		]);
		expect(m.topTracks[0].artist).toBe('Band X');
	});

	it('is empty and friendly for a year with nothing', () => {
		const y = yearInReview(d.user.id, 2019, TODAY);
		expect(y.headline).toEqual({ logged: 0, activeDays: 0, lists: 0, newItems: 0, soFar: false });
		expect(y.months).toEqual(Array(12).fill(0));
		expect(y).toMatchObject({ lists: [], watching: null, music: null });
		expect(y.highlights).toMatchObject({
			longestStreak: null,
			busiestMonth: null,
			busiestDay: null,
			topRated: null,
			newPlaces: 0,
			newArtists: 0,
			first: null,
			last: null
		});
	});

	it('is plain data that survives being sent to the browser', () => {
		expect(JSON.parse(JSON.stringify(r))).toEqual(r);
	});
});
