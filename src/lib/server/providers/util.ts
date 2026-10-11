import { rawDb } from '../db';

export class ProviderError extends Error {
	constructor(
		message: string,
		public status = 502
	) {
		super(message);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abortError() {
	return new DOMException('Aborted', 'AbortError');
}

/**
 * Spaces out calls to one API. Only the *start* of each call is serialized, and
 * callers whose request was abandoned (user kept typing) give up their slot.
 */
export function createLimiter(minIntervalMs: number) {
	let chain: Promise<void> = Promise.resolve();
	let last = 0;
	return async function schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const slot = chain.then(async () => {
			if (signal?.aborted) return;
			const wait = last + minIntervalMs - Date.now();
			if (wait > 0) await sleep(wait);
			last = Date.now();
		});
		chain = slot.catch(() => {});
		await slot;
		if (signal?.aborted) throw abortError();
		return fn();
	};
}

const inflight = new Map<string, Promise<unknown>>();

/** SQLite-backed response cache; concurrent identical requests share one upstream call. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
	const sqlite = rawDb();
	const row = sqlite.prepare('SELECT value, expires_at FROM provider_cache WHERE key = ?').get(key) as
		{ value: string; expires_at: number } | undefined;
	if (row && row.expires_at > Date.now()) return JSON.parse(row.value) as T;

	const pending = inflight.get(key);
	if (pending) return pending as Promise<T>;
	const p = (async () => {
		try {
			const value = await fn();
			sqlite
				.prepare('INSERT OR REPLACE INTO provider_cache (key, value, expires_at) VALUES (?, ?, ?)')
				.run(key, JSON.stringify(value), Date.now() + ttlMs);
			return value;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
	return p;
}

export function pruneProviderCache() {
	rawDb().prepare('DELETE FROM provider_cache WHERE expires_at < ?').run(Date.now());
}

export function withTimeout(signal: AbortSignal | undefined, ms: number) {
	const t = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, t]) : t;
}

export async function fetchOk(url: string | URL, init: RequestInit & { label: string }): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (e) {
		if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError') throw e;
		throw new ProviderError(`${init.label} could not be reached`);
	}
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError(`${init.label} rejected the API key (HTTP ${res.status})`, 502);
		}
		if (res.status === 404) throw new ProviderError(`${init.label}: not found`, 404);
		if (res.status === 429) throw new ProviderError(`${init.label} is rate limiting requests`, 503);
		throw new ProviderError(`${init.label} returned HTTP ${res.status}`);
	}
	return res;
}

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“',
	bull: '•',
	eacute: 'é',
	egrave: 'è',
	uuml: 'ü',
	ouml: 'ö',
	auml: 'ä',
	szlig: 'ß',
	times: '×',
	deg: '°',
	trade: '™',
	copy: '©',
	reg: '®'
};

/** Decodes HTML entities (BGG descriptions are double-encoded). */
export function decodeEntities(s: string): string {
	let out = s;
	for (let i = 0; i < 2; i++) {
		out = out
			.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
			.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
			.replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
	}
	return out;
}

export function yearOf(date: string | null | undefined) {
	const m = date?.match(/^(\d{4})/);
	return m ? m[1] : undefined;
}

export function joinNonEmpty(parts: (string | null | undefined)[], sep = ' · ') {
	return parts.filter((p) => p && String(p).trim()).join(sep) || undefined;
}

export function truncate(s: string | null | undefined, n: number) {
	if (!s) return undefined;
	return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
