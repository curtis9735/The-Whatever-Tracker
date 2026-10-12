import { XMLParser } from 'fast-xml-parser';
import { keys, userAgent } from '../settings';
import type { NormalizedMetadata, SearchResult } from '$lib/types';
import type { Provider } from './types';
import {
	cached,
	createLimiter,
	decodeEntities,
	fetchOk,
	joinNonEmpty,
	ProviderError,
	truncate,
	withTimeout
} from './util';

// BGG requires a registered-app Bearer token, sent to the host *without* "www",
// and asks for no more than one request every 2 seconds plus aggressive caching.
const BASE = 'https://boardgamegeek.com/xmlapi2';
const DAY = 86_400_000;
const limiter = createLimiter(2000);

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && ['item', 'name', 'link'].includes(name)
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseBggXml(xml: string) {
	return parser.parse(xml);
}

async function bggGet(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	const url = new URL(`${BASE}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await limiter(
			() =>
				fetchOk(url, {
					headers: {
						Authorization: `Bearer ${keys().bggToken}`,
						'User-Agent': userAgent(),
						Accept: 'application/xml'
					},
					signal: withTimeout(signal, 15000),
					label: 'BoardGameGeek'
				}).catch((e) => {
					if (e instanceof ProviderError && e.code === 'rate' && attempt < 2) return null; // 429: back off
					throw e;
				}),
			signal
		);
		if (res === null || res.status === 202) {
			await sleep(2000 * (attempt + 1));
			continue;
		}
		return parseBggXml(await res.text());
	}
	throw new ProviderError('BoardGameGeek is busy, try again in a moment', 503);
}

interface BggName {
	type: string;
	value: string;
}
interface BggSearchItem {
	id: string;
	type: string;
	name?: BggName[];
	yearpublished?: { value: string };
}
interface BggThing {
	id: string;
	type: string;
	thumbnail?: string;
	image?: string;
	name?: BggName[];
	description?: string;
	yearpublished?: { value: string };
	minplayers?: { value: string };
	maxplayers?: { value: string };
	playingtime?: { value: string };
	minage?: { value: string };
	link?: { type: string; id: string; value: string }[];
	statistics?: { ratings?: { average?: { value: string }; averageweight?: { value: string } } };
}

function primaryName(names?: BggName[]) {
	return names?.find((n) => n.type === 'primary')?.value ?? names?.[0]?.value ?? 'Untitled';
}

/** BGG returns search hits unordered; rank exact and prefix matches first, base games before expansions. */
export function rankBggSearch(q: string, items: BggSearchItem[], limit = 10): BggSearchItem[] {
	const needle = q.trim().toLowerCase();
	const seen = new Set<string>();
	const scored = items
		.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
		.map((i, idx) => {
			const name = primaryName(i.name).toLowerCase();
			let score = 3;
			if (name === needle) score = 0;
			else if (name.startsWith(needle)) score = 1;
			else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) score = 2;
			if (i.type === 'boardgameexpansion') score += 0.5;
			return { i, score, idx };
		})
		.sort((a, b) => a.score - b.score || a.idx - b.idx);
	return scored.slice(0, limit).map((s) => s.i);
}

function val(v?: { value: string }) {
	return v?.value && v.value !== '0' ? v.value : undefined;
}

export function normalizeBggThing(t: BggThing): NormalizedMetadata {
	const links = t.link ?? [];
	const by = (type: string) => links.filter((l) => l.type === type).map((l) => l.value);
	const year = val(t.yearpublished);
	const minP = val(t.minplayers);
	const maxP = val(t.maxplayers);
	const players = minP && maxP ? (minP === maxP ? minP : `${minP}–${maxP}`) : minP || maxP;
	const avg = t.statistics?.ratings?.average?.value;
	const weight = t.statistics?.ratings?.averageweight?.value;
	const description = t.description ? decodeEntities(String(t.description)).trim() : undefined;
	return {
		provider: 'bgg',
		kind: 'boardgame',
		kindKey: 'bgg:boardgame',
		id: String(t.id),
		title: decodeEntities(primaryName(t.name)),
		year,
		subtitle: joinNonEmpty([year, by('boardgamedesigner').slice(0, 2).join(', ')]),
		description,
		imageUrl: t.thumbnail || t.image,
		largeImageUrl: t.image || t.thumbnail,
		url: `https://boardgamegeek.com/boardgame/${t.id}`,
		genres: by('boardgamecategory').slice(0, 8),
		facts: [
			['Players', players],
			['Play time', val(t.playingtime) ? `${val(t.playingtime)} min` : undefined],
			['Age', val(t.minage) ? `${val(t.minage)}+` : undefined],
			['Designer', by('boardgamedesigner').join(', ')],
			['Publisher', by('boardgamepublisher').slice(0, 3).join(', ')],
			['Mechanics', by('boardgamemechanic').slice(0, 6).join(', ')],
			['BGG rating', avg && Number(avg) > 0 ? `${Number(avg).toFixed(1)}/10` : undefined],
			['Weight', weight && Number(weight) > 0 ? `${Number(weight).toFixed(2)}/5` : undefined]
		]
			.filter((f): f is [string, string] => !!f[1])
			.map(([label, value]) => ({ label, value }))
	};
}

async function things(ids: string[], signal?: AbortSignal): Promise<BggThing[]> {
	if (!ids.length) return [];
	const key = `bgg:things:${[...ids].sort().join(',')}`;
	return cached(key, 30 * DAY, async () => {
		const xml = (await bggGet('thing', { id: ids.join(','), stats: '1' }, signal)) as {
			items?: { item?: BggThing[] };
		};
		return xml.items?.item ?? [];
	});
}

export const bgg: Provider = {
	id: 'bgg',
	label: 'BoardGameGeek',
	kinds: ['bgg:boardgame'],
	env: ['BGG_API_TOKEN'],
	docsUrl: 'https://boardgamegeek.com/applications',
	timeoutMs: 15000,
	enabled: () => !!keys().bggToken,
	async test(signal) {
		// CATAN; uncached so a bad token is noticed
		const xml = (await bggGet('thing', { id: '13' }, signal)) as { items?: { item?: unknown[] } };
		if (!xml.items?.item?.length) throw new ProviderError('BoardGameGeek returned an unexpected answer');
	},
	async search(q, _kinds, signal): Promise<SearchResult[]> {
		const hits = await cached(`bgg:search:${q.toLowerCase()}`, 7 * DAY, async () => {
			const xml = (await bggGet('search', { query: q, type: 'boardgame' }, signal)) as {
				items?: { item?: BggSearchItem[] };
			};
			return rankBggSearch(q, xml.items?.item ?? []);
		});
		const details = await things(
			hits.map((h) => h.id),
			signal
		);
		const byId = new Map(details.map((d) => [String(d.id), d]));
		return hits.map((h) => {
			const d = byId.get(String(h.id));
			const year = val(h.yearpublished);
			const designers = (d?.link ?? []).filter((l) => l.type === 'boardgamedesigner').map((l) => l.value);
			return {
				provider: 'bgg',
				kind: 'boardgame',
				kindKey: 'bgg:boardgame',
				id: String(h.id),
				title: decodeEntities(primaryName(h.name)),
				year,
				subtitle: joinNonEmpty([
					year,
					designers[0],
					h.type === 'boardgameexpansion' ? 'Expansion' : undefined
				]),
				imageUrl: d?.thumbnail,
				description: truncate(d?.description ? decodeEntities(String(d.description)) : undefined, 240),
				url: `https://boardgamegeek.com/boardgame/${h.id}`
			};
		});
	},
	async details(kind, id, signal) {
		if (kind !== 'boardgame' || !/^\d+$/.test(id)) throw new Error('Bad BGG id');
		const [t] = await things([id], signal);
		if (!t) throw new ProviderError('BoardGameGeek: not found', 404);
		return normalizeBggThing(t);
	}
};
