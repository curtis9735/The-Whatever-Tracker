import { cfg } from '../config';
import type { SetlistEvent } from '$lib/types';
import { cached, createLimiter, fetchOk, ProviderError, withTimeout } from './util';

// setlist.fm: free key, 2 requests/second. Used from "Log a concert" rather than the global search.
const API = 'https://api.setlist.fm/rest/1.0';
const DAY = 86_400_000;
const limiter = createLimiter(600);

export function setlistfmEnabled() {
	return !!cfg().setlistfmKey;
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

export async function searchSetlists(
	artistMbid: string,
	opts: { date?: string; year?: string; city?: string; page?: number },
	signal?: AbortSignal
): Promise<{ events: SetlistEvent[]; total: number }> {
	if (!/^[0-9a-f-]{36}$/.test(artistMbid)) throw new ProviderError('Unknown artist', 400);
	const url = new URL(`${API}/search/setlists`);
	url.searchParams.set('artistMbid', artistMbid);
	if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
		const [y, m, d] = opts.date.split('-');
		url.searchParams.set('date', `${d}-${m}-${y}`);
	} else if (opts.year && /^\d{4}$/.test(opts.year)) {
		url.searchParams.set('year', opts.year);
	}
	if (opts.city?.trim()) url.searchParams.set('cityName', opts.city.trim());
	url.searchParams.set('p', String(opts.page ?? 1));

	return cached(`setlistfm:${url.search}`, DAY, () =>
		limiter(async () => {
			let res: Response;
			try {
				res = await fetchOk(url, {
					headers: { 'x-api-key': cfg().setlistfmKey, Accept: 'application/json', 'Accept-Language': 'en' },
					signal: withTimeout(signal, 10000),
					label: 'setlist.fm'
				});
			} catch (e) {
				// setlist.fm answers "no matches" with a 404
				if (e instanceof ProviderError && e.status === 404) return { events: [], total: 0 };
				throw e;
			}
			const json = (await res.json()) as { setlist?: RawSetlist[]; total?: number };
			return { events: (json.setlist ?? []).map(normalizeSetlist), total: json.total ?? 0 };
		}, signal)
	);
}
