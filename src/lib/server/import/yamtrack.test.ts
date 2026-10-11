import { describe, expect, it } from 'vitest';
import { ImportError, planYamtrackImport } from './yamtrack';

const header =
	'media_id,source,media_type,title,image,season_number,episode_number,score,progress,status,start_date,end_date,notes,created_at,progressed_at';

const csv = [
	header,
	'438631,tmdb,movie,Dune,https://image.tmdb.org/t/p/w500/d5NX.jpg,,,8.5,1,Completed,,2021-10-22 20:00:00+00:00,IMAX!,2021-10-22,2021-10-22',
	'438631,tmdb,movie,Dune,https://image.tmdb.org/t/p/w500/d5NX.jpg,,,9,1,Completed,,2024-03-01 20:00:00+00:00,,2024-03-01,2024-03-01',
	'1399,tmdb,tv,Game of Thrones,https://image.tmdb.org/t/p/w500/got.jpg,,,7,73,Completed,2019-01-01,2019-06-01,,2019-01-01,2019-06-01',
	'1399,tmdb,season,Game of Thrones,,1,,9,10,Completed,2019-01-01,2019-01-20,,2019-01-01,2019-01-20',
	'1399,tmdb,season,Game of Thrones,,2,,8,10,In progress,2019-02-01,,,2019-02-01,2019-02-01',
	'1399,tmdb,episode,Game of Thrones,,2,3,,,,,2019-02-05,,2019-02-05,',
	'1399,tmdb,episode,Game of Thrones,,2,7,,,,,2019-02-09,,2019-02-09,',
	'1399,tmdb,episode,Game of Thrones,,1,10,,,,,2019-01-20,,2019-01-20,',
	'1942,igdb,game,The Witcher 3,https://images.igdb.com/x.jpg,,,10,6000,Completed,2020-01-01,2020-04-01,,,',
	'13,bgg,boardgame,CATAN,,,,7,,Planning,,,,,',
	'5114,mal,anime,Fullmetal Alchemist: Brotherhood,https://cdn.myanimelist.net/x.jpg,,,10,64,Completed,,2018-05-05,,,',
	'99,manual,book,My Notebook,none.svg,,,,,Planning,,,,,',
	'1,tmdb,podcast,Unsupported,,,,,,,,,,,'
].join('\n');

describe('planYamtrackImport', () => {
	const plan = planYamtrackImport(csv);
	const byKey = Object.fromEntries(plan.items.map((i) => [i.key, i]));

	it('groups rows into items and skips unknown types', () => {
		expect(plan.rows).toBe(13);
		expect(plan.skipped).toBe(1);
		expect(Object.keys(byKey).sort()).toEqual(
			[
				'bgg:boardgame:13',
				'igdb:game:1942',
				'mal:anime:5114',
				'tmdb:movie:438631',
				'tmdb:tv:1399',
				'yamtrack:book:99'
			].sort()
		);
	});

	it('turns repeat watches into separate logs and keeps the latest score', () => {
		const dune = byKey['tmdb:movie:438631'];
		expect(dune.logs.map((l) => l.date)).toEqual(['2021-10-22', '2024-03-01']);
		expect(dune.rating).toBe(90);
		expect(dune.notes).toBe('IMAX!');
		expect(dune.image).toMatch(/^https:/);
	});

	it('makes seasons into logs and episodes into progress', () => {
		const got = byKey['tmdb:tv:1399'];
		expect(got.logs.map((l) => l.notes)).toEqual([null, 'Season 1', 'Season 2 (started)']);
		expect(got.progress).toEqual({ season: 2, episode: 7 });
		expect(got.status).toBe('Completed');
	});

	it('keeps non-live sources as external links', () => {
		expect(byKey['mal:anime:5114'].externalUrl).toBe('https://myanimelist.net/anime/5114');
		expect(byKey['yamtrack:book:99'].image).toBeNull();
		expect(byKey['bgg:boardgame:13'].logs).toEqual([]);
	});

	it('counts per media type', () => {
		expect(plan.counts.tv).toEqual({ items: 1, logs: 3 });
		expect(plan.counts.movie).toEqual({ items: 1, logs: 2 });
	});

	it('rejects files that are not Yamtrack exports', () => {
		expect(() => planYamtrackImport('name,rating\nfoo,5')).toThrow(ImportError);
	});
});
