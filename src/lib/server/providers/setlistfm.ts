import { keys } from '../settings';
import type { SetlistEvent } from '$lib/types';
import { cached, createLimiter, fetchOk, ProviderError, withTimeout } from './util';

// setlist.fm: free key. Its documented limit is 2 requests/second, but in practice requests
// 0.7 s apart already get "429 Too Many Requests", so keep them a full second apart.
// Used from "Log a concert" rather than the global search.
const API = 'https://api.setlist.fm/rest/1.0';
const DAY = 86_400_000;
const limiter = createLimiter(1100);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function setlistfmEnabled() {
	return !!keys().setlistfmKey;
}

function headers() {
	return { 'x-api-key': keys().setlistfmKey, Accept: 'application/json', 'Accept-Language': 'en' };
}

/** One rate-limited request, retried once if setlist.fm says we're going too fast. */
async function setlistGet(url: string | URL, signal?: AbortSignal): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await limiter(
				() => fetchOk(url, { headers: headers(), signal: withTimeout(signal, 10000), label: 'setlist.fm' }),
				signal
			);
		} catch (e) {
			if (attempt === 0 && e instanceof ProviderError && e.code === 'rate') {
				await sleep(2000);
				continue;
			}
			throw e;
		}
	}
}

/** Uncached artist lookup (Radiohead) to check the key. */
export async function testSetlistfm(signal?: AbortSignal) {
	await setlistGet(`${API}/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711`, signal);
}

interface RawSetlist {
	id: string;
	eventDate: string; // dd-MM-yyyy
	url?: string;
	artist: { mbid: string; name: string };
	venue?: {
		name?: string;
		city?: { name?: string; stateCode?: string; country?: { code?: string; name?: string } };
	};
	tour?: { name?: string };
	sets?: {
		set?: {
			name?: string;
			encore?: number;
			song?: { name: string; info?: string; cover?: { name: string } }[];
		}[];
	};
}

export function normalizeSetlist(s: RawSetlist): SetlistEvent {
	const [d, m, y] = s.eventDate.split('-');
	const city = s.venue?.city;
	const songs: SetlistEvent['songs'] = [];
	for (const set of s.sets?.set ?? []) {
		const label = set.encore ? (set.encore > 1 ? `Encore ${set.encore}` : 'Encore') : set.name;
		for (const song of set.song ?? []) {
			if (!song.name) continue;
			songs.push({ name: song.name, set: label || undefined, info: song.info, cover: song.cover?.name });
		}
	}
	return {
		id: s.id,
		date: `${y}-${m}-${d}`,
		artist: s.artist.name,
		venue: s.venue?.name ?? '',
		city: [city?.name, city?.stateCode].filter(Boolean).join(', '),
		country: city?.country?.name ?? '',
		tour: s.tour?.name,
		url: s.url,
		songs
	};
}

export interface SetlistQuery {
	/** Artist from MusicBrainz (exact), or a name for artists added by hand (setlist.fm matches it loosely) */
	artist: { mbid: string } | { name: string };
	date?: string; // YYYY-MM-DD
	year?: string;
	city?: string;
	venue?: string;
	page?: number;
}

export function setlistSearchUrl(q: SetlistQuery) {
	const url = new URL(`${API}/search/setlists`);
	if ('mbid' in q.artist) {
		if (!/^[0-9a-f-]{36}$/.test(q.artist.mbid)) throw new ProviderError('Unknown artist', 400);
		url.searchParams.set('artistMbid', q.artist.mbid);
	} else {
		const name = q.artist.name.trim();
		if (!name) throw new ProviderError('Unknown artist', 400);
		url.searchParams.set('artistName', name.slice(0, 200));
	}
	if (q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
		const [y, m, d] = q.date.split('-');
		url.searchParams.set('date', `${d}-${m}-${y}`);
	} else if (q.year && /^\d{4}$/.test(q.year)) {
		url.searchParams.set('year', q.year);
	}
	if (q.city?.trim()) url.searchParams.set('cityName', q.city.trim().slice(0, 100));
	if (q.venue?.trim()) url.searchParams.set('venueName', q.venue.trim().slice(0, 100));
	url.searchParams.set('p', String(q.page ?? 1));
	return url;
}

export async function searchSetlists(
	q: SetlistQuery,
	signal?: AbortSignal
): Promise<{ events: SetlistEvent[]; total: number }> {
	const url = setlistSearchUrl(q);
	// Setlists appear on setlist.fm in the days after a show, so "nothing yet" is only cached briefly
	const ttl = (r: { total: number }) => (r.total > 0 ? DAY : 10 * 60_000);
	return cached(`setlistfm:${url.search}`, ttl, async () => {
		let res: Response;
		try {
			res = await setlistGet(url, signal);
		} catch (e) {
			// setlist.fm answers "no matches" with a 404
			if (e instanceof ProviderError && e.code === 'notfound') return { events: [], total: 0 };
			throw e;
		}
		const json = (await res.json()) as { setlist?: RawSetlist[]; total?: number };
		return { events: (json.setlist ?? []).map(normalizeSetlist), total: json.total ?? 0 };
	});
}
