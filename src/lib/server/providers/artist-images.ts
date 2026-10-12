import { userAgent } from '../settings';
import { cached, fetchOk, withTimeout } from './util';

// MusicBrainz has no artist photos. Look one up instead, most exact source first:
// 1. Wikidata's image for the artist (MusicBrainz links the Wikidata entry by id)
// 2. A Wikimedia Commons photo linked straight from MusicBrainz
// 3. Deezer's artist picture, matched by exact name (no key needed)
const DAY = 86_400_000;
const WIDTH = '500';

/** "Beyoncé", "beyonce" and "BEYONCÉ!" compare equal. */
export function foldName(s: string) {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** "https://commons.wikimedia.org/wiki/File:Ed_Sheeran_2013.jpg" → "Ed_Sheeran_2013.jpg" */
export function commonsFileFromUrl(url: string | undefined) {
	const m = url?.match(/^https?:\/\/commons\.wikimedia\.org\/wiki\/File:(.+)$/);
	if (!m) return undefined;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return undefined;
	}
}

export function wikidataIdFromUrl(url: string | undefined) {
	return url?.match(/^https?:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/)?.[1];
}

interface DeezerArtist {
	name: string;
	nb_fan?: number;
	picture_big?: string;
}

/** The best-known Deezer artist with exactly this name that has a real picture. */
export function pickDeezerPicture(results: DeezerArtist[], name: string) {
	const want = foldName(name);
	return results
		.filter((a) => foldName(a.name) === want && a.picture_big && !a.picture_big.includes('/artist//'))
		.sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0]?.picture_big;
}

async function getJson<T>(url: string | URL, label: string, signal: AbortSignal, headers = {}) {
	const res = await fetchOk(url, { headers: { Accept: 'application/json', ...headers }, signal, label });
	return (await res.json()) as T;
}

async function wikidataImageFile(qid: string, signal: AbortSignal) {
	const url = new URL('https://www.wikidata.org/w/api.php');
	url.search = new URLSearchParams({
		action: 'wbgetclaims',
		format: 'json',
		property: 'P18',
		entity: qid
	}).toString();
	const json = await getJson<{ claims?: { P18?: { mainsnak?: { datavalue?: { value?: string } } }[] } }>(
		url,
		'Wikidata',
		signal,
		{ 'User-Agent': userAgent() }
	);
	return json.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
}

async function commonsThumb(file: string, signal: AbortSignal) {
	const url = new URL('https://commons.wikimedia.org/w/api.php');
	url.search = new URLSearchParams({
		action: 'query',
		format: 'json',
		prop: 'imageinfo',
		iiprop: 'url',
		iiurlwidth: WIDTH,
		titles: `File:${file}`
	}).toString();
	const json = await getJson<{
		query?: { pages?: Record<string, { imageinfo?: { thumburl?: string; url?: string }[] }> };
	}>(url, 'Wikimedia Commons', signal, { 'User-Agent': userAgent() });
	const info = Object.values(json.query?.pages ?? {})[0]?.imageinfo?.[0];
	// Drop the tracking query string Commons appends
	return (info?.thumburl ?? info?.url)?.split('?')[0];
}

async function deezerPicture(name: string, signal: AbortSignal) {
	const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`;
	// Deezer reports errors (e.g. its quota) as JSON with HTTP 200 and no `data`
	const json = await getJson<{ data?: DeezerArtist[] }>(url, 'Deezer', signal);
	return pickDeezerPicture(json.data ?? [], name);
}

export interface ArtistRef {
	id: string;
	name: string;
	relations?: { type: string; url?: { resource: string } }[];
}

/** A photo of the artist, or null. Never throws: a missing picture shouldn't block adding someone. */
export async function artistImage(a: ArtistRef, signal?: AbortSignal): Promise<string | null> {
	try {
		const found = await cached(
			`artist-image:${a.id}`,
			(v: { url: string | null }) => (v.url ? 30 * DAY : DAY),
			() => lookUp(a, withTimeout(signal, 8000))
		);
		return found.url;
	} catch {
		return null;
	}
}

async function lookUp(a: ArtistRef, signal: AbortSignal): Promise<{ url: string | null }> {
	const rel = (type: string) => a.relations?.find((r) => r.type === type)?.url?.resource;
	let failed = false;
	const attempt = async (fn: () => Promise<string | undefined>) => {
		try {
			return await fn();
		} catch (e) {
			if (signal.aborted) throw e;
			failed = true;
			return undefined;
		}
	};

	const qid = wikidataIdFromUrl(rel('wikidata'));
	const file =
		(qid && (await attempt(() => wikidataImageFile(qid, signal)))) || commonsFileFromUrl(rel('image'));
	const url =
		(file && (await attempt(() => commonsThumb(file, signal)))) ||
		(await attempt(() => deezerPicture(a.name, signal)));
	// Only remember "no picture" when every source actually answered
	if (!url && failed) throw new Error('Artist image lookup incomplete');
	return { url: url ?? null };
}
