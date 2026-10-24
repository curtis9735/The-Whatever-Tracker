import { keys, userAgent } from '../settings';
import { lastfmAlbumId, lastfmArtistId, parseLastfmAlbumId, parseLastfmArtistId } from '../album-match';
import type { AlbumTrack, NormalizedMetadata, SearchResult } from '$lib/types';
import type { Provider } from './types';
import { artistImage } from './artist-images';
import {
	cached,
	createLimiter,
	decodeEntities,
	ProviderError,
	truncate,
	withTimeout,
	type ProviderErrorCode
} from './util';

// last.fm API 2.0: a free API key, about 5 requests/second allowed per key. Everything in the app
// (search, details, history sync) shares one limiter so a big import never starves a search.
const API = 'https://ws.audioscrobbler.com/2.0/';
const DAY = 86_400_000;
let limiter = createLimiter(250);

/** Changes the spacing between calls (tests use a tiny one so a big import doesn't take minutes) */
export function setLastfmMinInterval(ms: number) {
	limiter = createLimiter(ms);
}

/** last.fm's "no picture" star; artists never get a real photo from last.fm */
const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

/** A failed last.fm call. `lfm` is last.fm's own error number, or null for network trouble. */
export class LastfmError extends ProviderError {
	constructor(
		message: string,
		public lfm: number | null,
		status: number,
		code: ProviderErrorCode
	) {
		super(message, status, code);
	}
}

function lfmError(lfm: number, message: string | undefined): LastfmError {
	switch (lfm) {
		case 10:
		case 26:
			return new LastfmError('last.fm rejected the API key', lfm, 502, 'auth');
		case 6:
			return new LastfmError(message || 'last.fm: not found', lfm, 404, 'notfound');
		case 17:
			return new LastfmError('That last.fm listening history is private', lfm, 502, 'private');
		case 29:
			return new LastfmError('last.fm is rate limiting requests', lfm, 503, 'rate');
		case 8:
		case 11:
		case 16:
			return new LastfmError('last.fm is having trouble right now', lfm, 502, 'unreachable');
		default:
			return new LastfmError(message || `last.fm error ${lfm}`, lfm, 502, 'other');
	}
}

/** Maps a failed HTTP status that came without a last.fm error body */
function httpError(status: number): LastfmError {
	if (status === 401 || status === 403)
		return new LastfmError('last.fm rejected the API key', null, 502, 'auth');
	if (status === 404) return new LastfmError('last.fm: not found', null, 404, 'notfound');
	if (status === 429) return new LastfmError('last.fm is rate limiting requests', null, 503, 'rate');
	if (status >= 500) return new LastfmError('last.fm could not be reached', null, 502, 'unreachable');
	return new LastfmError(`last.fm returned HTTP ${status}`, null, 502, 'other');
}

/**
 * One last.fm call. Errors arrive as `{error, message}` with HTTP 200 or 4xx, so the body is read
 * before the status is looked at (which is why fetchOk can't be used). A non-JSON reply is an outage.
 */
export async function lfmGet<T = Record<string, unknown>>(
	method: string,
	params: Record<string, string | number | undefined>,
	signal?: AbortSignal
): Promise<T> {
	const key = keys().lastfmKey;
	if (!key) throw new LastfmError('last.fm has no API key yet', null, 503, 'auth');
	const url = new URL(API);
	url.searchParams.set('method', method);
	for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
	url.searchParams.set('api_key', key);
	url.searchParams.set('format', 'json');

	return limiter(async () => {
		let res: Response;
		let text: string;
		try {
			res = await fetch(url, {
				headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
				signal: withTimeout(signal, 10000)
			});
			text = await res.text();
		} catch (e) {
			// The caller giving up is not an outage, but our own timeout is
			if (signal?.aborted) throw e;
			throw new LastfmError('last.fm could not be reached', null, 502, 'unreachable');
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw httpError(res.ok ? 502 : res.status);
		}
		const body = json as { error?: unknown; message?: unknown } | null;
		if (body && typeof body === 'object' && body.error !== undefined) {
			throw lfmError(Number(body.error), typeof body.message === 'string' ? body.message : undefined);
		}
		if (!res.ok) throw httpError(res.status);
		return json as T;
	}, signal);
}

// Response quirks: numbers are strings, one-element lists are plain objects, text is in '#text'

/** `undefined`, one thing or a list → always a list */
export function toArray<T>(v: T | T[] | null | undefined): T[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

const num = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type LfmSize = 'small' | 'medium' | 'large' | 'extralarge' | 'mega';

/** The first real picture in the preferred size order. The placeholder star and empty strings don't count. */
export function pickImage(
	images: unknown,
	prefer: LfmSize[] = ['extralarge', 'large', 'medium', 'small']
): string | undefined {
	const list = toArray(images as { size?: string; '#text'?: string }[] | undefined);
	for (const size of prefer) {
		for (const img of list) {
			const url = img?.['#text'];
			if (img?.size === size && url && !url.includes(PLACEHOLDER)) return url;
		}
	}
	return undefined;
}

/** A wiki or bio summary as plain text: no tags, no "Read more on Last.fm" link, at most 600 characters */
export function cleanWiki(s: string | null | undefined): string | undefined {
	if (!s) return undefined;
	const text = decodeEntities(
		s
			.replace(/<a\b[^>]*>\s*Read more on Last\.fm\s*<\/a>\.?/gi, '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]*>/g, '')
	)
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return truncate(text, 600) || undefined;
}

/** Tags people stick on everything, which say nothing about the music */
const TAG_BLOCKLIST = new Set([
	'seen live',
	'albums i own',
	'favorite',
	'favourite',
	'favorite albums',
	'favourite albums',
	'my favorite',
	'owned',
	'vinyl'
]);

/** The top 6 useful tags. Accepts the `tags` object (`{tag: [...]}`) or the list itself. */
export function tagsToGenres(tags: unknown): string[] {
	const inner = Array.isArray(tags) ? tags : (tags as { tag?: unknown } | undefined)?.tag;
	const out: string[] = [];
	for (const t of toArray(inner as { name?: string }[] | undefined)) {
		const name = str(t?.name).trim();
		if (!name || /^\d{4}$/.test(name) || TAG_BLOCKLIST.has(name.toLowerCase())) continue;
		if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
		if (out.length === 6) break;
	}
	return out;
}

const count = (n: number) => n.toLocaleString('en-US');

function facts(list: [string, string | number | null | undefined][]) {
	return list
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([label, value]) => ({ label, value: String(value) }));
}

/** An artist is a plain string in most replies and an object in track lists */
function artistName(a: unknown): string {
	if (typeof a === 'string') return a;
	const o = a as { name?: unknown; '#text'?: unknown } | null;
	return str(o?.name) || str(o?.['#text']);
}

function length(seconds: number) {
	if (seconds <= 0) return undefined;
	const min = Math.round(seconds / 60);
	return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
}

interface LfmAlbumMatch {
	name?: string;
	artist?: unknown;
	url?: string;
	image?: unknown;
	mbid?: string;
}

interface LfmArtistMatch {
	name?: string;
	listeners?: string | number;
	url?: string;
	mbid?: string;
}

export function normalizeLfmAlbumSearch(json: {
	results?: { albummatches?: { album?: LfmAlbumMatch | LfmAlbumMatch[] } };
}): SearchResult[] {
	const out: SearchResult[] = [];
	for (const a of toArray(json.results?.albummatches?.album)) {
		const title = str(a?.name);
		const artist = artistName(a?.artist);
		if (!title || !artist) continue;
		out.push({
			provider: 'lastfm',
			kind: 'album',
			kindKey: 'lastfm:album',
			id: lastfmAlbumId(artist, title),
			title,
			subtitle: artist,
			imageUrl: pickImage(a.image, ['large', 'extralarge', 'medium', 'small']),
			url: a.url || undefined
		});
	}
	return out;
}

export function normalizeLfmArtistSearch(json: {
	results?: { artistmatches?: { artist?: LfmArtistMatch | LfmArtistMatch[] } };
}): SearchResult[] {
	const out: SearchResult[] = [];
	for (const a of toArray(json.results?.artistmatches?.artist)) {
		const name = str(a?.name);
		if (!name) continue;
		const listeners = num(a.listeners);
		out.push({
			provider: 'lastfm',
			kind: 'artist',
			kindKey: 'lastfm:artist',
			id: lastfmArtistId(name),
			title: name,
			subtitle: listeners ? `${count(listeners)} listeners` : undefined,
			url: a.url || undefined
		});
	}
	return out;
}

interface LfmTrack {
	name?: string;
	duration?: string | number;
	'@attr'?: { rank?: string | number };
}

/** The tracklist in order (by last.fm's rank when it has one); tracks without a name are dropped */
export function albumTracks(tracks: LfmTrack[]): AlbumTrack[] {
	return tracks
		.map((t, i) => ({ t, i, rank: num(t?.['@attr']?.rank) }))
		.filter(({ t }) => str(t?.name).trim())
		.sort((a, b) => (a.rank && b.rank ? a.rank - b.rank : 0) || a.i - b.i)
		.map(({ t }) => ({ name: str(t.name).trim(), duration: num(t.duration) > 0 ? num(t.duration) : null }));
}

interface LfmAlbumInfo {
	name?: string;
	artist?: unknown;
	url?: string;
	image?: unknown;
	listeners?: string | number;
	playcount?: string | number;
	tags?: unknown;
	tracks?: { track?: LfmTrack[] | LfmTrack };
	wiki?: { summary?: string };
}

/** `album` is the inner object of an `album.getInfo` reply */
export function normalizeLfmAlbum(album: LfmAlbumInfo): NormalizedMetadata {
	const title = str(album.name);
	const artist = artistName(album.artist);
	const tracks = toArray(album.tracks?.track);
	const seconds = tracks.reduce((sum, t) => sum + num(t?.duration), 0);
	const image = pickImage(album.image);
	return {
		provider: 'lastfm',
		kind: 'album',
		kindKey: 'lastfm:album',
		id: lastfmAlbumId(artist, title),
		title,
		subtitle: artist || undefined,
		artist: artist || undefined,
		description: cleanWiki(album.wiki?.summary),
		imageUrl: image,
		largeImageUrl: image,
		url: album.url || undefined,
		tracks: albumTracks(tracks),
		genres: tagsToGenres(album.tags),
		facts: facts([
			['Artist', artist],
			['Tracks', tracks.length || undefined],
			['Length', length(seconds)],
			['Listeners', num(album.listeners) ? count(num(album.listeners)) : undefined],
			['Scrobbles worldwide', num(album.playcount) ? count(num(album.playcount)) : undefined]
		])
	};
}

interface LfmArtistInfo {
	name?: string;
	mbid?: string;
	url?: string;
	stats?: { listeners?: string | number; playcount?: string | number };
	tags?: unknown;
	bio?: { summary?: string };
	similar?: { artist?: { name?: string }[] | { name?: string } };
}

/** `artist` is the inner object of an `artist.getInfo` reply; `image` comes from artistImage() */
export function normalizeLfmArtist(artist: LfmArtistInfo, image?: string | null): NormalizedMetadata {
	const name = str(artist.name);
	const similar = toArray(artist.similar?.artist)
		.map((a) => str(a?.name))
		.filter(Boolean)
		.slice(0, 5);
	const listeners = num(artist.stats?.listeners);
	const plays = num(artist.stats?.playcount);
	return {
		provider: 'lastfm',
		kind: 'artist',
		kindKey: 'lastfm:artist',
		id: lastfmArtistId(name),
		title: name,
		subtitle: listeners ? `${count(listeners)} listeners` : undefined,
		description: cleanWiki(artist.bio?.summary),
		mbid: str(artist.mbid) || undefined,
		imageUrl: image ?? undefined,
		url: artist.url || undefined,
		genres: tagsToGenres(artist.tags),
		facts: facts([
			['Listeners', listeners ? count(listeners) : undefined],
			['Scrobbles worldwide', plays ? count(plays) : undefined],
			['Similar', similar.join(', ')]
		])
	};
}

export const lastfm: Provider = {
	id: 'lastfm',
	label: 'last.fm',
	kinds: ['lastfm:album', 'lastfm:artist'],
	env: ['LASTFM_API_KEY'],
	docsUrl: 'https://www.last.fm/api/account/create',
	timeoutMs: 10000,
	enabled: () => !!keys().lastfmKey,
	async test(signal) {
		// Radiohead lookup: last.fm answers error 10 for a key it doesn't know
		await lfmGet('artist.getInfo', { artist: 'Radiohead' }, signal);
	},
	async search(q, kinds, signal) {
		const tasks: Promise<SearchResult[]>[] = [];
		if (kinds.includes('lastfm:album')) {
			tasks.push(
				cached(`lfm:album-search:${q.toLowerCase()}`, DAY, async () =>
					normalizeLfmAlbumSearch(await lfmGet('album.search', { album: q, limit: 8 }, signal))
				)
			);
		}
		if (kinds.includes('lastfm:artist')) {
			tasks.push(
				cached(`lfm:artist-search:${q.toLowerCase()}`, DAY, async () =>
					normalizeLfmArtistSearch(await lfmGet('artist.search', { artist: q, limit: 8 }, signal))
				)
			);
		}
		return (await Promise.all(tasks)).flat();
	},
	async details(kind, id, signal) {
		if (kind === 'album') {
			const ref = parseLastfmAlbumId(id);
			if (!ref) throw new ProviderError('Bad last.fm album id', 400);
			const json = await cached(
				`lfm:album:${id}`,
				7 * DAY,
				() =>
					lfmGet<{ album?: LfmAlbumInfo }>(
						'album.getInfo',
						{ artist: ref.artist, album: ref.title, autocorrect: 1 },
						signal
					),
				{ staleIfError: true }
			);
			if (!json.album) throw new ProviderError('last.fm: not found', 404, 'notfound');
			return normalizeLfmAlbum(json.album);
		}
		if (kind === 'artist') {
			const name = parseLastfmArtistId(id);
			if (!name) throw new ProviderError('Bad last.fm artist id', 400);
			const json = await cached(
				`lfm:artist:${id}`,
				7 * DAY,
				() => lfmGet<{ artist?: LfmArtistInfo }>('artist.getInfo', { artist: name, autocorrect: 1 }, signal),
				{ staleIfError: true }
			);
			if (!json.artist) throw new ProviderError('last.fm: not found', 404, 'notfound');
			// last.fm only has a placeholder star for artists, so the photo is looked up elsewhere
			const found = str(json.artist.name) || name;
			const photo = await artistImage({ id: json.artist.mbid || `lastfm:${found}`, name: found }, signal);
			return normalizeLfmArtist(json.artist, photo);
		}
		throw new ProviderError(`last.fm has no kind ${kind}`, 400);
	}
};

/** One listen from a user's history */
export interface Scrobble {
	/** When it was played (unix seconds) */
	uts: number;
	artist: string;
	artistMbid: string | null;
	/** Empty when the track has no album; the sync skips those but still counts them for its cursor */
	album: string;
	albumMbid: string | null;
	track: string;
	/** Album art (extralarge, else the best there is), or null */
	imageUrl: string | null;
}

/**
 * A page of `user.getRecentTracks`. The "now playing" entry (it has no date) is left out; plays
 * without an album are kept, with `album: ''`.
 */
export function parseRecentTracks(json: unknown): { total: number; plays: Scrobble[] } {
	const rt = (json as { recenttracks?: Record<string, unknown> } | null)?.recenttracks ?? {};
	const total = num((rt['@attr'] as { total?: unknown } | undefined)?.total);
	const plays: Scrobble[] = [];
	for (const t of toArray(rt.track as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
		if ((t['@attr'] as { nowplaying?: unknown } | undefined)?.nowplaying === 'true') continue;
		const uts = num((t.date as { uts?: unknown } | undefined)?.uts);
		if (!uts) continue;
		const artist = t.artist as { '#text'?: string; name?: string; mbid?: string } | string | undefined;
		const album = t.album as { '#text'?: string; mbid?: string } | undefined;
		plays.push({
			uts,
			artist: artistName(artist),
			artistMbid: (typeof artist === 'object' && artist?.mbid) || null,
			album: str(album?.['#text']),
			albumMbid: album?.mbid || null,
			track: str(t.name),
			imageUrl: pickImage(t.image) ?? null
		});
	}
	return { total, plays };
}

/** The newest-first plays in a window: `from` and `to` are unix seconds, each optional; `page` counts from 1 */
export async function getRecentTracks(
	user: string,
	opts: { from?: number; to?: number; limit?: number; page?: number } = {},
	signal?: AbortSignal
): Promise<{ total: number; plays: Scrobble[] }> {
	const json = await lfmGet(
		'user.getRecentTracks',
		{ user, limit: opts.limit ?? 200, page: opts.page ?? 1, from: opts.from, to: opts.to },
		signal
	);
	return parseRecentTracks(json);
}

/** Checks a username exists. `name` has last.fm's own capitalization. */
export async function getUserInfo(
	user: string,
	signal?: AbortSignal
): Promise<{ name: string; playcount: number; registeredUts: number }> {
	const json = await lfmGet<{
		user?: { name?: string; playcount?: string; registered?: { unixtime?: string } };
	}>('user.getInfo', { user }, signal);
	if (!json.user) throw new LastfmError('last.fm: not found', 6, 404, 'notfound');
	return {
		name: str(json.user.name) || user,
		playcount: num(json.user.playcount),
		registeredUts: num(json.user.registered?.unixtime)
	};
}
