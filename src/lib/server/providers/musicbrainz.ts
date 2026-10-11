import { cfg, userAgent } from '../config';
import type { NormalizedMetadata, SearchResult } from '$lib/types';
import type { Provider } from './types';
import { cached, createLimiter, fetchOk, joinNonEmpty, ProviderError, withTimeout, yearOf } from './util';

// MusicBrainz: no key, but a contact User-Agent is required and the limit is 1 request/second.
const API = 'https://musicbrainz.org/ws/2';
const DAY = 86_400_000;
const limiter = createLimiter(1100);

async function mbGet<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const url = new URL(API + path);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	url.searchParams.set('fmt', 'json');
	return limiter(async () => {
		const res = await fetchOk(url, {
			headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
			signal: withTimeout(signal, 10000),
			label: 'MusicBrainz'
		});
		return (await res.json()) as T;
	}, signal);
}

/** Escapes Lucene query syntax so user text is searched literally. */
export function luceneEscape(s: string) {
	return s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
}

export function coverArt(releaseGroupId: string, size: 250 | 500 = 250) {
	return `https://coverartarchive.org/release-group/${releaseGroupId}/front-${size}`;
}

interface MbArtist {
	id: string;
	name: string;
	type?: string;
	country?: string;
	disambiguation?: string;
	area?: { name: string };
	'life-span'?: { begin?: string; end?: string; ended?: boolean };
	genres?: { name: string; count: number }[];
	tags?: { name: string; count: number }[];
	relations?: { type: string; url?: { resource: string } }[];
}

interface MbReleaseGroup {
	id: string;
	title: string;
	'primary-type'?: string;
	'secondary-types'?: string[];
	'first-release-date'?: string;
	'artist-credit'?: { name: string; joinphrase?: string; artist: { id: string; name: string } }[];
	genres?: { name: string; count: number }[];
	tags?: { name: string; count: number }[];
}

function credit(rg: MbReleaseGroup) {
	return (rg['artist-credit'] ?? []).map((c) => c.name + (c.joinphrase ?? '')).join('') || undefined;
}

export function normalizeMbArtist(a: MbArtist): SearchResult {
	const begin = yearOf(a['life-span']?.begin);
	return {
		provider: 'musicbrainz',
		kind: 'artist',
		kindKey: 'musicbrainz:artist',
		id: a.id,
		title: a.name,
		year: begin,
		subtitle: joinNonEmpty([
			a.type,
			a.area?.name ?? a.country,
			a.disambiguation,
			begin ? `since ${begin}` : undefined
		]),
		url: `https://musicbrainz.org/artist/${a.id}`
	};
}

export function normalizeMbReleaseGroup(rg: MbReleaseGroup): SearchResult {
	const year = yearOf(rg['first-release-date']);
	return {
		provider: 'musicbrainz',
		kind: 'album',
		kindKey: 'musicbrainz:album',
		id: rg.id,
		title: rg.title,
		year,
		subtitle: joinNonEmpty([credit(rg), year, rg['primary-type']]),
		imageUrl: coverArt(rg.id, 250),
		url: `https://musicbrainz.org/release-group/${rg.id}`
	};
}

function topGenres(g?: { name: string; count: number }[], t?: { name: string; count: number }[]) {
	const src = g?.length ? g : (t ?? []);
	return [...src]
		.sort((a, b) => b.count - a.count)
		.slice(0, 6)
		.map((x) => x.name);
}

export function normalizeMbArtistDetails(a: MbArtist): NormalizedMetadata {
	const base = normalizeMbArtist(a);
	const span = a['life-span'];
	const active = span?.begin
		? `${yearOf(span.begin)}–${span.ended ? (yearOf(span.end) ?? '?') : 'present'}`
		: '';
	const homepage = a.relations?.find((r) => r.type === 'official homepage')?.url?.resource;
	return {
		...base,
		subtitle: joinNonEmpty([a.type, a.area?.name ?? a.country]),
		description: a.disambiguation || undefined,
		genres: topGenres(a.genres, a.tags),
		facts: [
			['Type', a.type],
			['From', a.area?.name ?? a.country],
			['Active', active],
			['Website', homepage]
		]
			.filter((f): f is [string, string] => !!f[1])
			.map(([label, value]) => ({ label, value }))
	};
}

export function normalizeMbReleaseGroupDetails(rg: MbReleaseGroup): NormalizedMetadata {
	return {
		...normalizeMbReleaseGroup(rg),
		largeImageUrl: coverArt(rg.id, 500),
		genres: topGenres(rg.genres, rg.tags),
		facts: [
			['Artist', credit(rg)],
			['Released', rg['first-release-date']],
			['Type', [rg['primary-type'], ...(rg['secondary-types'] ?? [])].filter(Boolean).join(', ')]
		]
			.filter((f): f is [string, string] => !!f[1])
			.map(([label, value]) => ({ label, value }))
	};
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const musicbrainz: Provider = {
	id: 'musicbrainz',
	label: 'MusicBrainz',
	kinds: ['musicbrainz:artist', 'musicbrainz:album'],
	env: ['MUSICBRAINZ_CONTACT'],
	docsUrl: 'https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting',
	timeoutMs: 10000,
	enabled: () => !!cfg().musicbrainzContact,
	async search(q, kinds, signal) {
		const query = luceneEscape(q);
		const tasks: Promise<SearchResult[]>[] = [];
		if (kinds.includes('musicbrainz:artist')) {
			tasks.push(
				cached(`mb:artist-search:${q.toLowerCase()}`, DAY, async () => {
					const json = await mbGet<{ artists?: MbArtist[] }>('/artist', { query, limit: '8' }, signal);
					return (json.artists ?? []).map(normalizeMbArtist);
				})
			);
		}
		if (kinds.includes('musicbrainz:album')) {
			tasks.push(
				cached(`mb:rg-search:${q.toLowerCase()}`, DAY, async () => {
					const json = await mbGet<{ 'release-groups'?: MbReleaseGroup[] }>(
						'/release-group',
						{ query, limit: '8' },
						signal
					);
					return (json['release-groups'] ?? []).map(normalizeMbReleaseGroup);
				})
			);
		}
		return (await Promise.all(tasks)).flat();
	},
	async details(kind, id, signal) {
		if (!MBID.test(id)) throw new Error('Bad MusicBrainz id');
		if (kind === 'artist') {
			const a = await cached(`mb:artist:${id}`, 7 * DAY, () =>
				mbGet<MbArtist>(`/artist/${id}`, { inc: 'genres+tags+url-rels' }, signal)
			);
			return normalizeMbArtistDetails(a);
		}
		if (kind === 'album') {
			const rg = await cached(`mb:rg:${id}`, 7 * DAY, () =>
				mbGet<MbReleaseGroup>(`/release-group/${id}`, { inc: 'artist-credits+genres+tags' }, signal)
			);
			return normalizeMbReleaseGroupDetails(rg);
		}
		throw new ProviderError(`MusicBrainz has no kind ${kind}`, 400);
	}
};
