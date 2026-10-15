import { keys } from '../settings';
import type { NormalizedMetadata, SearchResult } from '$lib/types';
import type { Provider, ReleaseInput } from './types';
import { cached, fetchOk, joinNonEmpty, truncate, withTimeout, yearOf } from './util';

const API = 'https://api.themoviedb.org/3';
const DAY = 86_400_000;

export function tmdbImage(path: string | null | undefined, size: 'w185' | 'w342' | 'w780' = 'w342') {
	return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

async function tmdbGet(path: string, params: Record<string, string>, signal?: AbortSignal) {
	const key = keys().tmdbKey;
	const url = new URL(API + path);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const headers: Record<string, string> = { Accept: 'application/json' };
	// v4 "API Read Access Token" is a JWT; the classic v3 key is 32 hex chars
	if (key.includes('.')) headers.Authorization = `Bearer ${key}`;
	else url.searchParams.set('api_key', key);
	const res = await fetchOk(url, { headers, signal: withTimeout(signal, 8000), label: 'TMDB' });
	return res.json();
}

interface TmdbMultiResult {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	title?: string;
	name?: string;
	release_date?: string;
	first_air_date?: string;
	poster_path?: string | null;
	overview?: string;
	popularity?: number;
}

export function normalizeTmdbSearch(json: { results?: TmdbMultiResult[] }, kinds: string[]): SearchResult[] {
	const out: SearchResult[] = [];
	for (const r of json.results ?? []) {
		if (r.media_type !== 'movie' && r.media_type !== 'tv') continue;
		const kindKey = `tmdb:${r.media_type}`;
		if (!kinds.includes(kindKey)) continue;
		const year = yearOf(r.media_type === 'movie' ? r.release_date : r.first_air_date);
		out.push({
			provider: 'tmdb',
			kind: r.media_type,
			kindKey,
			id: String(r.id),
			title: (r.media_type === 'movie' ? r.title : r.name) ?? 'Untitled',
			year,
			subtitle: joinNonEmpty([year, r.media_type === 'tv' ? 'TV series' : 'Movie']),
			imageUrl: tmdbImage(r.poster_path, 'w185'),
			description: truncate(r.overview, 240),
			url: `https://www.themoviedb.org/${r.media_type}/${r.id}`
		});
	}
	return out;
}

interface Credits {
	cast?: { name: string; order?: number }[];
	crew?: { name: string; job: string }[];
}

function runtime(min: number | null | undefined) {
	if (!min) return undefined;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h ? `${h}h ${m}m` : `${m}m`;
}

function facts(list: [string, string | number | null | undefined][]) {
	return list
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([label, value]) => ({ label, value: String(value) }));
}

export function normalizeTmdbMovie(m: {
	id: number;
	title: string;
	tagline?: string;
	overview?: string;
	release_date?: string;
	runtime?: number;
	genres?: { name: string }[];
	poster_path?: string | null;
	vote_average?: number;
	imdb_id?: string | null;
	original_language?: string;
	credits?: Credits;
}): NormalizedMetadata {
	const directors = (m.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name);
	const cast = (m.credits?.cast ?? []).slice(0, 6).map((c) => c.name);
	const year = yearOf(m.release_date);
	return {
		provider: 'tmdb',
		kind: 'movie',
		kindKey: 'tmdb:movie',
		id: String(m.id),
		title: m.title,
		year,
		subtitle: joinNonEmpty([year, directors.join(', ')]),
		description: m.overview || undefined,
		imageUrl: tmdbImage(m.poster_path, 'w342'),
		largeImageUrl: tmdbImage(m.poster_path, 'w780'),
		url: `https://www.themoviedb.org/movie/${m.id}`,
		genres: (m.genres ?? []).map((g) => g.name),
		facts: facts([
			['Released', m.release_date],
			['Runtime', runtime(m.runtime)],
			['Director', directors.join(', ')],
			['Cast', cast.join(', ')],
			['Tagline', m.tagline],
			['TMDB score', m.vote_average ? `${m.vote_average.toFixed(1)}/10` : undefined],
			['IMDb', m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : undefined]
		])
	};
}

export function normalizeTmdbTv(t: {
	id: number;
	name: string;
	overview?: string;
	first_air_date?: string;
	last_air_date?: string;
	number_of_seasons?: number;
	number_of_episodes?: number;
	status?: string;
	genres?: { name: string }[];
	networks?: { name: string }[];
	created_by?: { name: string }[];
	poster_path?: string | null;
	vote_average?: number;
	credits?: Credits;
}): NormalizedMetadata {
	const year = yearOf(t.first_air_date);
	const cast = (t.credits?.cast ?? []).slice(0, 6).map((c) => c.name);
	return {
		provider: 'tmdb',
		kind: 'tv',
		kindKey: 'tmdb:tv',
		id: String(t.id),
		title: t.name,
		year,
		subtitle: joinNonEmpty([year, (t.networks ?? []).map((n) => n.name).join(', ')]),
		description: t.overview || undefined,
		imageUrl: tmdbImage(t.poster_path, 'w342'),
		largeImageUrl: tmdbImage(t.poster_path, 'w780'),
		url: `https://www.themoviedb.org/tv/${t.id}`,
		genres: (t.genres ?? []).map((g) => g.name),
		facts: facts([
			['First aired', t.first_air_date],
			['Last aired', t.last_air_date],
			['Seasons', t.number_of_seasons],
			['Episodes', t.number_of_episodes],
			['Status', t.status],
			['Created by', (t.created_by ?? []).map((c) => c.name).join(', ')],
			['Network', (t.networks ?? []).map((n) => n.name).join(', ')],
			['Cast', cast.join(', ')],
			['TMDB score', t.vote_average ? `${t.vote_average.toFixed(1)}/10` : undefined]
		])
	};
}

// --- Release dates (Calendar) ------------------------------------------------------------

const HOUR = 3_600_000;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

interface TmdbEpisode {
	air_date?: string | null;
	season_number?: number;
	episode_number?: number;
	name?: string;
}

/** Every episode of a season that has an air date. */
export function normalizeTmdbSeason(s: { season_number?: number; episodes?: TmdbEpisode[] }): ReleaseInput[] {
	return (s.episodes ?? [])
		.filter((e) => isDate(e.air_date))
		.map((e) => ({
			kind: 'episode' as const,
			date: e.air_date as string,
			season: e.season_number ?? s.season_number,
			episode: e.episode_number,
			title: e.name?.trim() || undefined
		}));
}

/**
 * Episodes of the season that aired last and the one airing next (often the same one).
 * Finished shows are re-checked monthly, running ones twice a day.
 */
export async function tmdbTvReleases(id: string, signal?: AbortSignal): Promise<ReleaseInput[]> {
	if (!/^\d+$/.test(id)) throw new Error('Bad TMDB id');
	const show = await cached<{
		status?: string;
		last_episode_to_air?: TmdbEpisode | null;
		next_episode_to_air?: TmdbEpisode | null;
	}>(
		`tmdb:tv-air:${id}`,
		(v) => (/ended|canceled/i.test(v.status ?? '') ? 30 * DAY : 12 * HOUR),
		() => tmdbGet(`/tv/${id}`, {}, signal)
	);
	const seasons = new Set<number>();
	for (const ep of [show.last_episode_to_air, show.next_episode_to_air]) {
		if (typeof ep?.season_number === 'number') seasons.add(ep.season_number);
	}
	const ended = /ended|canceled/i.test(show.status ?? '');
	const out: ReleaseInput[] = [];
	for (const n of seasons) {
		const season = await cached(`tmdb:tv-season:${id}:${n}`, ended ? 30 * DAY : 12 * HOUR, () =>
			tmdbGet(`/tv/${id}/season/${n}`, {}, signal)
		);
		out.push(...normalizeTmdbSeason(season));
	}
	return out;
}

/** A movie's release date. Long-released movies are re-checked monthly. */
export async function tmdbMovieRelease(id: string, signal?: AbortSignal): Promise<ReleaseInput[]> {
	if (!/^\d+$/.test(id)) throw new Error('Bad TMDB id');
	const recent = (d: string) => Date.now() - Date.parse(d) < 60 * DAY;
	const movie = await cached(
		`tmdb:movie-release:${id}`,
		(v: { release_date?: string }) =>
			isDate(v.release_date) && !recent(v.release_date) ? 30 * DAY : 12 * HOUR,
		() => tmdbGet(`/movie/${id}`, {}, signal)
	);
	return isDate(movie.release_date) ? [{ kind: 'movie', date: movie.release_date }] : [];
}

export const tmdb: Provider = {
	id: 'tmdb',
	label: 'TMDB',
	kinds: ['tmdb:movie', 'tmdb:tv'],
	env: ['TMDB_API_KEY'],
	docsUrl: 'https://www.themoviedb.org/settings/api',
	timeoutMs: 8000,
	enabled: () => !!keys().tmdbKey,
	async test(signal) {
		// Requires a valid key; answers 401 otherwise
		await tmdbGet('/configuration', {}, signal);
	},
	async search(q, kinds, signal) {
		const json = await cached(`tmdb:search:${q.toLowerCase()}`, DAY, () =>
			tmdbGet('/search/multi', { query: q, include_adult: 'false', page: '1' }, signal)
		);
		return normalizeTmdbSearch(json, kinds).slice(0, 16);
	},
	async details(kind, id, signal) {
		if (!/^\d+$/.test(id)) throw new Error('Bad TMDB id');
		if (kind === 'movie') {
			const json = await cached(`tmdb:movie:${id}`, 7 * DAY, () =>
				tmdbGet(`/movie/${id}`, { append_to_response: 'credits' }, signal)
			);
			return normalizeTmdbMovie(json);
		}
		if (kind === 'tv') {
			const json = await cached(`tmdb:tv:${id}`, 7 * DAY, () =>
				tmdbGet(`/tv/${id}`, { append_to_response: 'credits' }, signal)
			);
			return normalizeTmdbTv(json);
		}
		throw new Error(`TMDB has no kind ${kind}`);
	}
};
