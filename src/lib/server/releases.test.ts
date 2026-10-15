import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-releases-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), TMDB_API_KEY: 'test-key' } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { createItem, updateItem } = await import('./services/items');
const releases = await import('./services/releases');
const { normalizeTmdbSeason } = await import('./providers/tmdb');

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** TMDB as far as the Calendar uses it: a running show (seasons 2 and 3) and an upcoming movie */
function fakeTmdb() {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => {
			const path = new URL(String(input)).pathname.replace('/3', '');
			calls.push(path);
			if (path === '/tv/100') {
				return json({
					status: 'Returning Series',
					last_episode_to_air: { season_number: 2 },
					next_episode_to_air: { season_number: 3 }
				});
			}
			if (path === '/tv/100/season/2') {
				return json({
					season_number: 2,
					episodes: [{ air_date: '2026-09-30', episode_number: 8, name: 'Old finale' }]
				});
			}
			if (path === '/tv/100/season/3') {
				return json({
					season_number: 3,
					episodes: [
						{ air_date: '2026-10-14', episode_number: 1, name: 'Premiere' },
						{ air_date: '2026-10-21', episode_number: 2, name: 'Second' },
						{ air_date: null, episode_number: 3, name: 'TBA' }
					]
				});
			}
			if (path === '/movie/200') return json({ release_date: '2026-10-20', status: 'Post Production' });
			return new Response('{}', { status: 404 });
		})
	);
	return calls;
}

let n = 0;
function account(showId = '100', movieId = '200') {
	const user = db()
		.insert(schema.users)
		.values({ username: `cal${++n}`, displayName: 'x', passwordHash: 'x' })
		.returning()
		.get();
	const tv = createCategoryFromTemplate(user.id, 'tv-shows');
	const movies = createCategoryFromTemplate(user.id, 'movies');
	const show = createItem(user.id, {
		categoryId: tv.id,
		title: 'The Show',
		status: 'watching',
		provider: 'tmdb',
		providerKind: 'tv',
		providerId: showId
	});
	const movie = createItem(user.id, {
		categoryId: movies.id,
		title: 'The Movie',
		status: 'planning',
		provider: 'tmdb',
		providerKind: 'movie',
		providerId: movieId
	});
	return { user, tv, movies, show, movie };
}

describe('release look-ups', () => {
	it('turn a TMDB season into dated episodes, skipping ones without a date', () => {
		expect(
			normalizeTmdbSeason({
				season_number: 3,
				episodes: [
					{ air_date: '2026-10-14', episode_number: 1, name: ' Premiere ' },
					{ air_date: '', episode_number: 2 },
					{ air_date: null, episode_number: 3 }
				]
			})
		).toEqual([{ kind: 'episode', date: '2026-10-14', season: 3, episode: 1, title: 'Premiere' }]);
	});

	it('store episodes of the last and next season, and movie release dates', async () => {
		fakeTmdb();
		const a = account();
		const result = await releases.refreshReleases(a.user.id);
		expect(result).toEqual({ items: 2, releases: 4, failed: 0 });

		const oct = releases.releasesBetween(a.user.id, '2026-09-27', '2026-10-31');
		expect(oct.map((e) => [e.date, e.title, e.label, e.episodeTitle])).toEqual([
			['2026-09-30', 'The Show', 'S2 E8', 'Old finale'],
			['2026-10-14', 'The Show', 'S3 E1', 'Premiere'],
			['2026-10-20', 'The Movie', 'Movie release', null],
			['2026-10-21', 'The Show', 'S3 E2', 'Second']
		]);
		expect(releases.releasesCheckedAt(a.user.id)).toBeInstanceOf(Date);
	});

	it('looking up again replaces the old dates instead of adding to them', async () => {
		fakeTmdb();
		const a = account();
		await releases.refreshReleases(a.user.id);
		await releases.refreshReleases(a.user.id);
		expect(releases.releasesBetween(a.user.id, '2026-01-01', '2026-12-31')).toHaveLength(4);
	});

	it('hide lists that are switched off, and dropped shows', async () => {
		fakeTmdb();
		const a = account();
		await releases.refreshReleases(a.user.id);
		releases.setListInCalendar(a.user.id, a.movies.id, false);
		expect(releases.releasesBetween(a.user.id, '2026-01-01', '2026-12-31').map((e) => e.title)).not.toContain(
			'The Movie'
		);
		expect(releases.calendarLists(a.user.id).find((l) => l.id === a.movies.id)).toMatchObject({
			shown: false,
			linked: 1
		});

		updateItem(a.user.id, a.show.id, { status: 'dropped' });
		expect(releases.releasesBetween(a.user.id, '2026-01-01', '2026-12-31')).toEqual([]);
		// ...and the next look-up forgets the dropped show's dates
		await releases.refreshReleases(a.user.id);
		expect(
			db()
				.select()
				.from(schema.releases)
				.all()
				.filter((r) => r.itemId === a.show.id)
		).toEqual([]);
	});

	it('never shows another account’s releases', async () => {
		fakeTmdb();
		const a = account();
		const b = account();
		await releases.refreshReleases(a.user.id);
		expect(releases.releasesBetween(b.user.id, '2026-01-01', '2026-12-31')).toEqual([]);
		releases.setListInCalendar(b.user.id, a.movies.id, false); // not b's list: no effect
		expect(getCategoryById(a.user.id, a.movies.id).category.showInCalendar).toBe(true);
	});

	it('a source that fails is counted, and the rest still saved', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				const path = new URL(String(input)).pathname.replace('/3', '');
				if (path === '/movie/201') return json({ release_date: '2026-11-01' });
				throw new TypeError('fetch failed'); // the show (id 101, not cached yet)
			})
		);
		const a = account('101', '201');
		const result = await releases.refreshReleases(a.user.id);
		expect(result).toMatchObject({ items: 2, failed: 1, releases: 1 });
	});
});
