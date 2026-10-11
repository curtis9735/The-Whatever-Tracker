import { describe, expect, it } from 'vitest';
import { normalizeTmdbMovie, normalizeTmdbSearch, normalizeTmdbTv } from './tmdb';
import { normalizeIgdbGame, normalizeIgdbSearch } from './igdb';
import { normalizeBggThing, parseBggXml, rankBggSearch } from './bgg';
import { luceneEscape, normalizeMbArtist, normalizeMbReleaseGroup } from './musicbrainz';
import { normalizeSetlist } from './setlistfm';
import { normalizeOff } from './openfoodfacts';
import { decodeEntities } from './util';

describe('TMDB', () => {
	const multi = {
		results: [
			{
				id: 438631,
				media_type: 'movie',
				title: 'Dune',
				release_date: '2021-09-15',
				poster_path: '/d5NX.jpg',
				overview: 'Paul…'
			},
			{
				id: 90228,
				media_type: 'tv',
				name: 'Dune: Prophecy',
				first_air_date: '2024-11-17',
				poster_path: null
			},
			{ id: 1, media_type: 'person', name: 'Someone' }
		]
	};

	it('splits multi-search into movie and TV kinds and drops people', () => {
		const r = normalizeTmdbSearch(multi as never, ['tmdb:movie', 'tmdb:tv']);
		expect(r.map((x) => x.kindKey)).toEqual(['tmdb:movie', 'tmdb:tv']);
		expect(r[0]).toMatchObject({
			id: '438631',
			title: 'Dune',
			year: '2021',
			imageUrl: 'https://image.tmdb.org/t/p/w185/d5NX.jpg'
		});
		expect(r[1].imageUrl).toBeUndefined();
	});

	it('only returns requested kinds', () => {
		expect(normalizeTmdbSearch(multi as never, ['tmdb:tv']).map((x) => x.title)).toEqual(['Dune: Prophecy']);
	});

	it('normalizes movie and TV details', () => {
		const m = normalizeTmdbMovie({
			id: 438631,
			title: 'Dune',
			release_date: '2021-09-15',
			runtime: 155,
			genres: [{ name: 'Science Fiction' }],
			credits: {
				crew: [{ name: 'Denis Villeneuve', job: 'Director' }],
				cast: [{ name: 'Timothée Chalamet' }]
			}
		});
		expect(m.subtitle).toBe('2021 · Denis Villeneuve');
		expect(m.facts).toContainEqual({ label: 'Runtime', value: '2h 35m' });
		const t = normalizeTmdbTv({ id: 1, name: 'Show', number_of_seasons: 3, networks: [{ name: 'HBO' }] });
		expect(t.facts).toContainEqual({ label: 'Seasons', value: '3' });
		expect(t.kindKey).toBe('tmdb:tv');
	});
});

describe('IGDB', () => {
	it('normalizes search and details', () => {
		const [g] = normalizeIgdbSearch([
			{
				id: 1942,
				name: 'The Witcher 3: Wild Hunt',
				first_release_date: 1431993600,
				cover: { image_id: 'co1wyy' },
				platforms: [{ abbreviation: 'PC' }, { abbreviation: 'PS4' }]
			}
		]);
		expect(g).toMatchObject({
			kindKey: 'igdb:game',
			year: '2015',
			subtitle: '2015 · PC, PS4',
			imageUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1wyy.jpg'
		});
		const d = normalizeIgdbGame({
			id: 1942,
			name: 'The Witcher 3',
			involved_companies: [
				{ company: { name: 'CD Projekt RED' }, developer: true, publisher: false },
				{ company: { name: 'CD Projekt' }, developer: false, publisher: true }
			]
		});
		expect(d.facts).toContainEqual({ label: 'Developer', value: 'CD Projekt RED' });
		expect(d.facts).toContainEqual({ label: 'Publisher', value: 'CD Projekt' });
	});
});

describe('BoardGameGeek', () => {
	const searchXml = `<?xml version="1.0" encoding="utf-8"?>
<items total="3" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
	<item type="boardgame" id="278"><name type="primary" value="Catan Card Game"/><yearpublished value="1996"/></item>
	<item type="boardgameexpansion" id="926"><name type="primary" value="Catan: Seafarers"/><yearpublished value="1997"/></item>
	<item type="boardgame" id="13"><name type="primary" value="CATAN"/><yearpublished value="1995"/></item>
</items>`;

	it('parses search XML and ranks the exact match first, expansions after base games', () => {
		const items = parseBggXml(searchXml).items.item;
		const ranked = rankBggSearch('catan', items);
		expect(ranked.map((i: { id: string }) => i.id)).toEqual(['13', '278', '926']);
	});

	it('normalizes a thing with double-encoded description', () => {
		const xml = `<items><item type="boardgame" id="13">
			<thumbnail>https://cf.geekdo-images.com/thumb.jpg</thumbnail>
			<image>https://cf.geekdo-images.com/full.jpg</image>
			<name type="primary" sortindex="1" value="CATAN"/>
			<name type="alternate" sortindex="1" value="Die Siedler von Catan"/>
			<description>Trade &amp;mdash; build &amp;amp; settle.&amp;#10;Fun.</description>
			<yearpublished value="1995"/><minplayers value="3"/><maxplayers value="4"/>
			<playingtime value="120"/><minage value="10"/>
			<link type="boardgamecategory" id="1021" value="Economic"/>
			<link type="boardgamedesigner" id="11" value="Klaus Teuber"/>
			<statistics page="1"><ratings><average value="7.09"/><averageweight value="2.29"/></ratings></statistics>
		</item></items>`;
		const t = normalizeBggThing(parseBggXml(xml).items.item[0]);
		expect(t.title).toBe('CATAN');
		expect(t.description).toBe('Trade — build & settle.\nFun.');
		expect(t.facts).toContainEqual({ label: 'Players', value: '3–4' });
		expect(t.facts).toContainEqual({ label: 'BGG rating', value: '7.1/10' });
		expect(t.imageUrl).toBe('https://cf.geekdo-images.com/thumb.jpg');
		expect(t.genres).toEqual(['Economic']);
	});

	it('decodes entities', () => {
		expect(decodeEntities('Rock &amp;amp; Roll &#8211; &hellip;')).toBe('Rock & Roll – …');
	});
});

describe('MusicBrainz', () => {
	it('escapes Lucene syntax', () => {
		expect(luceneEscape('AC/DC: Back (in) Black!')).toBe('AC\\/DC\\: Back \\(in\\) Black\\!');
	});

	it('normalizes artists and release groups', () => {
		const a = normalizeMbArtist({
			id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
			name: 'Radiohead',
			type: 'Group',
			area: { name: 'United Kingdom' },
			'life-span': { begin: '1991' }
		});
		expect(a).toMatchObject({
			kindKey: 'musicbrainz:artist',
			subtitle: 'Group · United Kingdom · since 1991'
		});
		const rg = normalizeMbReleaseGroup({
			id: 'b1392450-e666-3926-a536-22c65f834433',
			title: 'OK Computer',
			'primary-type': 'Album',
			'first-release-date': '1997-05-21',
			'artist-credit': [{ name: 'Radiohead', artist: { id: 'x', name: 'Radiohead' } }]
		});
		expect(rg.subtitle).toBe('Radiohead · 1997 · Album');
		expect(rg.imageUrl).toBe(
			'https://coverartarchive.org/release-group/b1392450-e666-3926-a536-22c65f834433/front-250'
		);
	});
});

describe('setlist.fm', () => {
	it('flattens sets and converts the date', () => {
		const e = normalizeSetlist({
			id: '63de4613',
			eventDate: '23-08-2023',
			url: 'https://www.setlist.fm/setlist/x.html',
			artist: { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead' },
			venue: {
				name: 'Madison Square Garden',
				city: { name: 'New York', stateCode: 'NY', country: { code: 'US', name: 'United States' } }
			},
			tour: { name: 'Tour' },
			sets: {
				set: [
					{ song: [{ name: 'Airbag' }, { name: 'Creep', info: 'first time since 2009' }] },
					{ encore: 1, song: [{ name: 'Karma Police' }] },
					{ encore: 2, song: [{ name: 'Gimme Shelter', cover: { name: 'The Rolling Stones' } }] }
				]
			}
		});
		expect(e.date).toBe('2023-08-23');
		expect(e.city).toBe('New York, NY');
		expect(e.songs.map((s) => s.set ?? '')).toEqual(['', '', 'Encore', 'Encore 2']);
		expect(e.songs[3].cover).toBe('The Rolling Stones');
	});
});

describe('Open Food Facts', () => {
	it('uses the English name and first brand', () => {
		const p = normalizeOff('0123456789012', {
			status: 1,
			product: {
				product_name: 'Sauce piquante',
				product_name_en: 'Hot sauce',
				brands: 'Cholula, Other',
				image_front_url: 'https://img/x.jpg'
			}
		});
		expect(p).toMatchObject({ title: 'Hot sauce', brand: 'Cholula', imageUrl: 'https://img/x.jpg' });
		expect(normalizeOff('1', { status: 0 })).toBeNull();
	});
});
