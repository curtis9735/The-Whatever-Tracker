import { keys } from '../settings';
import type { NormalizedMetadata, SearchResult } from '$lib/types';
import type { Provider, ReleaseInput } from './types';
import { cached, createLimiter, fetchOk, joinNonEmpty, ProviderError, truncate, withTimeout } from './util';

const DAY = 86_400_000;
const limiter = createLimiter(260); // IGDB allows 4 requests/second

// Remember which credentials the token belongs to, so changing them in Settings takes effect at once
let token: { value: string; expiresAt: number; forCredentials: string } | null = null;

async function getToken(signal?: AbortSignal) {
	const { igdbClientId, igdbClientSecret } = keys();
	const forCredentials = `${igdbClientId}:${igdbClientSecret}`;
	if (token && token.forCredentials === forCredentials && token.expiresAt > Date.now() + 60_000) {
		return token.value;
	}
	const url = new URL('https://id.twitch.tv/oauth2/token');
	url.searchParams.set('client_id', igdbClientId);
	url.searchParams.set('client_secret', igdbClientSecret);
	url.searchParams.set('grant_type', 'client_credentials');
	let res: Response;
	try {
		res = await fetchOk(url, {
			method: 'POST',
			signal: withTimeout(signal, 8000),
			label: 'Twitch (IGDB login)'
		});
	} catch (e) {
		// Twitch answers an unknown client ID with 400 rather than 401
		if (e instanceof ProviderError && /HTTP 400/.test(e.message)) {
			throw new ProviderError('Twitch rejected the client ID (HTTP 400)', 502, 'auth');
		}
		throw e;
	}
	const json = (await res.json()) as { access_token: string; expires_in: number };
	token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000, forCredentials };
	return token.value;
}

async function igdbQuery<T>(endpoint: string, body: string, signal?: AbortSignal, retry = true): Promise<T> {
	const access = await getToken(signal);
	return limiter(async () => {
		try {
			const res = await fetchOk(`https://api.igdb.com/v4/${endpoint}`, {
				method: 'POST',
				headers: {
					'Client-ID': keys().igdbClientId,
					Authorization: `Bearer ${access}`,
					Accept: 'application/json',
					'Content-Type': 'text/plain'
				},
				body,
				signal: withTimeout(signal, 8000),
				label: 'IGDB'
			});
			return (await res.json()) as T;
		} catch (e) {
			if (retry && e instanceof ProviderError && e.code === 'auth') {
				token = null; // expired or revoked token: log in again once
				return igdbQuery<T>(endpoint, body, signal, false);
			}
			throw e;
		}
	}, signal);
}

export function igdbImage(imageId: string | undefined, size: 't_cover_small' | 't_cover_big' | 't_720p') {
	return imageId ? `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg` : undefined;
}

interface IgdbGame {
	id: number;
	name: string;
	summary?: string;
	storyline?: string;
	first_release_date?: number;
	cover?: { image_id: string };
	platforms?: { abbreviation?: string; name?: string }[];
	genres?: { name: string }[];
	themes?: { name: string }[];
	game_modes?: { name: string }[];
	involved_companies?: { company: { name: string }; developer: boolean; publisher: boolean }[];
	total_rating?: number;
	url?: string;
}

function releaseYear(ts?: number) {
	return ts ? String(new Date(ts * 1000).getUTCFullYear()) : undefined;
}

export function normalizeIgdbSearch(games: IgdbGame[]): SearchResult[] {
	return games.map((g) => {
		const year = releaseYear(g.first_release_date);
		const platforms = (g.platforms ?? [])
			.map((p) => p.abbreviation || p.name)
			.filter(Boolean)
			.slice(0, 4)
			.join(', ');
		return {
			provider: 'igdb',
			kind: 'game',
			kindKey: 'igdb:game',
			id: String(g.id),
			title: g.name,
			year,
			subtitle: joinNonEmpty([year, platforms]),
			imageUrl: igdbImage(g.cover?.image_id, 't_cover_big'),
			description: truncate(g.summary, 240),
			url: g.url
		};
	});
}

export function normalizeIgdbGame(g: IgdbGame): NormalizedMetadata {
	const year = releaseYear(g.first_release_date);
	const companies = g.involved_companies ?? [];
	const developers = companies.filter((c) => c.developer).map((c) => c.company.name);
	const publishers = companies.filter((c) => c.publisher).map((c) => c.company.name);
	const date = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : '';
	return {
		provider: 'igdb',
		kind: 'game',
		kindKey: 'igdb:game',
		id: String(g.id),
		title: g.name,
		year,
		subtitle: joinNonEmpty([year, developers[0]]),
		description: g.summary || g.storyline || undefined,
		imageUrl: igdbImage(g.cover?.image_id, 't_cover_big'),
		largeImageUrl: igdbImage(g.cover?.image_id, 't_720p'),
		url: g.url,
		genres: [...(g.genres ?? []), ...(g.themes ?? [])].map((x) => x.name),
		facts: [
			['Released', date],
			['Platforms', (g.platforms ?? []).map((p) => p.name || p.abbreviation).join(', ')],
			['Developer', developers.join(', ')],
			['Publisher', publishers.join(', ')],
			['Modes', (g.game_modes ?? []).map((m) => m.name).join(', ')],
			['IGDB rating', g.total_rating ? `${Math.round(g.total_rating)}/100` : '']
		]
			.filter(([, v]) => v)
			.map(([label, value]) => ({ label, value }))
	};
}

/** A game's first release date, for the Calendar. Re-checked twice a day. */
export async function igdbRelease(id: string, signal?: AbortSignal): Promise<ReleaseInput[]> {
	if (!/^\d+$/.test(id)) throw new Error('Bad IGDB id');
	const games = await cached(`igdb:release:${id}`, DAY / 2, () =>
		igdbQuery<{ first_release_date?: number }[]>(
			'games',
			`fields first_release_date; where id = ${id};`,
			signal
		)
	);
	const ts = games[0]?.first_release_date;
	return ts ? [{ kind: 'game', date: new Date(ts * 1000).toISOString().slice(0, 10) }] : [];
}

function escapeApicalypse(s: string) {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export const igdb: Provider = {
	id: 'igdb',
	label: 'IGDB',
	kinds: ['igdb:game'],
	env: ['IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET'],
	docsUrl: 'https://api-docs.igdb.com/#account-creation',
	timeoutMs: 9000,
	enabled: () => !!(keys().igdbClientId && keys().igdbClientSecret),
	async test(signal) {
		await igdbQuery('games', 'fields id; limit 1;', signal);
	},
	async search(q, _kinds, signal) {
		const games = await cached(`igdb:search:${q.toLowerCase()}`, DAY, () =>
			igdbQuery<IgdbGame[]>(
				'games',
				`search "${escapeApicalypse(q)}"; fields name,first_release_date,cover.image_id,platforms.abbreviation,platforms.name,summary,url; where version_parent = null; limit 12;`,
				signal
			)
		);
		return normalizeIgdbSearch(games);
	},
	async details(kind, id, signal) {
		if (kind !== 'game' || !/^\d+$/.test(id)) throw new Error('Bad IGDB id');
		const games = await cached(`igdb:game:${id}`, 7 * DAY, () =>
			igdbQuery<IgdbGame[]>(
				'games',
				`fields name,summary,storyline,first_release_date,cover.image_id,genres.name,themes.name,platforms.name,platforms.abbreviation,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,game_modes.name,total_rating,url; where id = ${id};`,
				signal
			)
		);
		if (!games.length) throw new ProviderError('IGDB: not found', 404);
		return normalizeIgdbGame(games[0]);
	}
};
