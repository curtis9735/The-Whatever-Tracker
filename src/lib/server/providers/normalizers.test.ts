import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-normalizers-'));
	// A made-up key: the real API is never called, fetch is replaced in these tests
	return {
		env: {
			DATA_DIR: dir,
			MIGRATIONS_DIR: path.resolve('drizzle'),
			LASTFM_API_KEY: '0123456789abcdef0123456789abcdef'
		}
	};
});
vi.mock('./artist-images', async (orig) => ({
	...(await orig<typeof import('./artist-images')>()),
	artistImage: vi.fn(async () => 'https://photos.example/radiohead.jpg')
}));

import { normalizeTmdbMovie, normalizeTmdbSearch, normalizeTmdbTv } from './tmdb';
import { normalizeIgdbGame, normalizeIgdbSearch } from './igdb';
import { normalizeBggThing, parseBggXml, rankBggSearch } from './bgg';
import { luceneEscape, normalizeMbArtist, normalizeMbReleaseGroup } from './musicbrainz';
import { normalizeSetlist } from './setlistfm';
import { normalizeOff } from './openfoodfacts';
import { decodeEntities } from './util';
import {
	cleanWiki,
	lastfm,
	LastfmError,
	lfmGet,
	normalizeLfmAlbum,
	normalizeLfmAlbumSearch,
	normalizeLfmArtist,
	normalizeLfmArtistSearch,
	parseRecentTracks,
	pickImage,
	tagsToGenres,
	toArray
} from './lastfm';
import { lastfmArtistId, parseLastfmAlbumId, parseLastfmArtistId } from '../album-match';

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

describe('last.fm', () => {
	const STAR = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
	const img = (size: string, url: string) => ({ size, '#text': url });

	afterEach(() => vi.unstubAllGlobals());

	/** A fetch that answers with this body and status, and remembers the URLs asked for */
	function fakeLastfm(body: unknown, status = 200) {
		const urls: URL[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				urls.push(new URL(String(input)));
				return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
			})
		);
		return urls;
	}

	it('wraps a lone object in a list', () => {
		expect(toArray(undefined)).toEqual([]);
		expect(toArray({ a: 1 })).toEqual([{ a: 1 }]);
		expect(toArray([1, 2])).toEqual([1, 2]);
	});

	it('reads a search with a single result that comes back as an object', () => {
		const r = normalizeLfmAlbumSearch({
			results: {
				albummatches: {
					album: {
						name: 'OK Computer',
						artist: 'Radiohead',
						url: 'https://www.last.fm/music/Radiohead/OK+Computer',
						image: [img('small', 'https://img/s.png'), img('large', 'https://img/l.png')]
					}
				}
			}
		});
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({
			kindKey: 'lastfm:album',
			title: 'OK Computer',
			subtitle: 'Radiohead',
			imageUrl: 'https://img/l.png'
		});
		expect(parseLastfmAlbumId(r[0].id)).toEqual({ artist: 'Radiohead', title: 'OK Computer' });

		const a = normalizeLfmArtistSearch({
			results: { artistmatches: { artist: { name: 'Radiohead', listeners: '4821733', url: 'u' } } }
		});
		expect(a[0]).toMatchObject({ kindKey: 'lastfm:artist', subtitle: '4,821,733 listeners' });
		expect(parseLastfmArtistId(a[0].id)).toBe('Radiohead');
	});

	it('drops the placeholder star and empty images', () => {
		expect(pickImage([img('extralarge', STAR), img('large', '')])).toBeUndefined();
		expect(pickImage([img('extralarge', STAR), img('large', 'https://img/l.png')])).toBe('https://img/l.png');
		expect(pickImage(img('large', 'https://img/one.png'))).toBe('https://img/one.png');
		expect(pickImage(undefined)).toBeUndefined();
	});

	it('cleans wiki text', () => {
		expect(
			cleanWiki(
				'Kid A is the <a href="https://www.last.fm/x">fourth album</a> &amp; a hit. <a href="https://www.last.fm/music/R/Kid+A">Read more on Last.fm</a>'
			)
		).toBe('Kid A is the fourth album & a hit.');
		expect(cleanWiki('<a href="x">Read more on Last.fm</a>')).toBeUndefined();
		expect(cleanWiki(undefined)).toBeUndefined();
		const long = cleanWiki('word '.repeat(300))!;
		expect(long.length).toBeLessThanOrEqual(600);
		expect(long.endsWith('…')).toBe(true);
	});

	it('keeps the top useful tags as genres', () => {
		const tag = (name: string) => ({ name });
		const genres = tagsToGenres({
			tag: [
				tag('seen live'),
				tag('rock'),
				tag('1997'),
				tag('Albums I Own'),
				tag('alternative'),
				tag('favorite'),
				tag('vinyl'),
				tag('electronic'),
				tag('experimental'),
				tag('90s'),
				tag('art rock'),
				tag('britpop'),
				tag('indie')
			]
		});
		expect(genres).toEqual(['rock', 'alternative', 'electronic', 'experimental', '90s', 'art rock']);
		expect(tagsToGenres({ tag: { name: 'rock' } })).toEqual(['rock']);
		expect(tagsToGenres(undefined)).toEqual([]);
	});

	it('formats album facts', () => {
		const d = normalizeLfmAlbum({
			name: 'Kid A',
			artist: 'Radiohead',
			url: 'https://www.last.fm/music/Radiohead/Kid+A',
			image: [img('extralarge', 'https://img/xl.png')],
			listeners: '1234567',
			playcount: '98765432',
			tags: { tag: [{ name: 'electronic' }] },
			tracks: { track: [{ duration: '300' }, { duration: '3000' }] },
			wiki: { summary: 'An album. <a href="u">Read more on Last.fm</a>' }
		});
		expect(d).toMatchObject({
			kindKey: 'lastfm:album',
			title: 'Kid A',
			subtitle: 'Radiohead',
			artist: 'Radiohead',
			description: 'An album.',
			imageUrl: 'https://img/xl.png',
			genres: ['electronic']
		});
		expect(d.facts).toEqual([
			{ label: 'Artist', value: 'Radiohead' },
			{ label: 'Tracks', value: '2' },
			{ label: 'Length', value: '55 min' },
			{ label: 'Listeners', value: '1,234,567' },
			{ label: 'Scrobbles worldwide', value: '98,765,432' }
		]);
		// No track durations: no Length fact
		const bare = normalizeLfmAlbum({ name: 'X', artist: 'Y', tracks: { track: { duration: '0' } } });
		expect(bare.facts.map((f) => f.label)).toEqual(['Artist', 'Tracks']);
	});

	it('reads the tracklist in rank order, with durations when there are some', () => {
		const d = normalizeLfmAlbum({
			name: 'X',
			artist: 'Y',
			tracks: {
				track: [
					{ name: 'Two', duration: '181', '@attr': { rank: '2' } },
					{ name: 'One', duration: '0', '@attr': { rank: '1' } },
					{ duration: '90' }
				]
			}
		});
		expect(d.tracks).toEqual([
			{ name: 'One', duration: null },
			{ name: 'Two', duration: 181 }
		]);
		// One track comes as a plain object, none as nothing
		expect(normalizeLfmAlbum({ name: 'X', artist: 'Y', tracks: { track: { name: 'Solo' } } }).tracks).toEqual(
			[{ name: 'Solo', duration: null }]
		);
		expect(normalizeLfmAlbum({ name: 'X', artist: 'Y' }).tracks).toEqual([]);
	});

	it('formats artist facts, with the first five similar artists', () => {
		const d = normalizeLfmArtist(
			{
				name: 'Radiohead',
				stats: { listeners: '10', playcount: '2000' },
				similar: { artist: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name })) },
				bio: { summary: 'A band.' }
			},
			'https://photo'
		);
		expect(d.imageUrl).toBe('https://photo');
		expect(d.facts).toContainEqual({ label: 'Similar', value: 'a, b, c, d, e' });
		expect(d.facts).toContainEqual({ label: 'Scrobbles worldwide', value: '2,000' });
	});

	it('takes the artist photo from artistImage, since last.fm only has a star', async () => {
		fakeLastfm({ artist: { name: 'Radiohead', image: [img('extralarge', STAR)] } });
		const d = await lastfm.details('artist', lastfmArtistId('Radiohead'));
		expect(d.imageUrl).toBe('https://photos.example/radiohead.jpg');
	});

	it('maps last.fm errors', async () => {
		fakeLastfm({ error: 6, message: 'Album not found' });
		await expect(lfmGet('album.getInfo', {})).rejects.toMatchObject({ code: 'notfound', lfm: 6 });

		fakeLastfm({ error: 10, message: 'Invalid API key' }, 403);
		await expect(lfmGet('album.getInfo', {})).rejects.toMatchObject({ code: 'auth', lfm: 10 });

		fakeLastfm({ error: 29, message: 'Rate limit exceeded' }, 429);
		await expect(lfmGet('album.getInfo', {})).rejects.toMatchObject({ code: 'rate', lfm: 29 });

		fakeLastfm({ error: 17, message: 'Login: User required to be logged in' });
		await expect(lfmGet('user.getRecentTracks', {})).rejects.toMatchObject({
			code: 'private',
			lfm: 17
		});

		fakeLastfm({ error: 8, message: 'Operation failed' });
		await expect(lfmGet('album.getInfo', {})).rejects.toMatchObject({ code: 'unreachable', lfm: 8 });

		fakeLastfm('<html>Service Unavailable</html>', 503);
		const e = await lfmGet('album.getInfo', {}).catch((x) => x);
		expect(e).toBeInstanceOf(LastfmError);
		expect(e).toMatchObject({ code: 'unreachable', lfm: null });

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		await expect(lfmGet('album.getInfo', {})).rejects.toMatchObject({ code: 'unreachable' });
	});

	it('sends the key, format and parameters, leaving out empty ones', async () => {
		const urls = fakeLastfm({ ok: 1 });
		await lfmGet('user.getRecentTracks', { user: 'rj', limit: 200, from: undefined, to: 99 });
		const q = urls[0].searchParams;
		expect(q.get('method')).toBe('user.getRecentTracks');
		expect(q.get('format')).toBe('json');
		expect(q.get('api_key')).toBe('0123456789abcdef0123456789abcdef');
		expect(q.get('limit')).toBe('200');
		expect(q.get('to')).toBe('99');
		expect(q.has('from')).toBe(false);
	});

	it('reads recent tracks: skips now playing, keeps albumless plays', () => {
		const { total, plays } = parseRecentTracks({
			recenttracks: {
				'@attr': { total: '118532' },
				track: [
					{
						name: 'Live now',
						artist: { '#text': 'Radiohead', mbid: '' },
						album: { '#text': 'Kid A', mbid: '' },
						'@attr': { nowplaying: 'true' }
					},
					{
						name: 'Everything In Its Right Place',
						artist: { '#text': 'Radiohead', mbid: 'a74b1b7f' },
						album: { '#text': 'Kid A', mbid: 'b1392450' },
						image: [img('extralarge', 'https://img/kida.png')],
						date: { uts: '1700000100' }
					},
					{
						name: 'Loose single',
						artist: { '#text': 'Someone' },
						album: { '#text': '' },
						image: [img('extralarge', STAR)],
						date: { uts: '1700000000' }
					}
				]
			}
		});
		expect(total).toBe(118532);
		expect(plays).toEqual([
			{
				uts: 1700000100,
				artist: 'Radiohead',
				artistMbid: 'a74b1b7f',
				album: 'Kid A',
				albumMbid: 'b1392450',
				track: 'Everything In Its Right Place',
				imageUrl: 'https://img/kida.png'
			},
			{
				uts: 1700000000,
				artist: 'Someone',
				artistMbid: null,
				album: '',
				albumMbid: null,
				track: 'Loose single',
				imageUrl: null
			}
		]);
		// One track comes back as an object, an empty history as no track at all
		const one = { name: 't', artist: { '#text': 'a' }, date: { uts: '5' } };
		expect(parseRecentTracks({ recenttracks: { track: one } }).plays).toHaveLength(1);
		expect(parseRecentTracks({ recenttracks: { '@attr': { total: '0' } } })).toEqual({
			total: 0,
			plays: []
		});
	});
});
