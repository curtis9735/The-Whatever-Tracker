import { rawDb } from '../db';

/**
 * `auth` means the source rejected our credentials (used to refuse saving a bad key).
 * `private` is a profile whose owner hides it (last.fm listening history).
 */
export type ProviderErrorCode = 'auth' | 'rate' | 'notfound' | 'unreachable' | 'private' | 'other';

export class ProviderError extends Error {
	constructor(
		message: string,
		public status = 502,
		public code: ProviderErrorCode = 'other'
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

/** How long an expired answer is served again after the source fails, before retrying */
const STALE_RETRY_MS = 15 * 60_000;

/**
 * SQLite-backed response cache; concurrent identical requests share one upstream call.
 * `ttl` can depend on the answer (e.g. cache empty results briefly). With `staleIfError`, the saved
 * answer (even an expired one) is used when the source is down, slow or refuses the key.
 */
export async function cached<T>(
	key: string,
	ttl: number | ((value: T) => number),
	fn: () => Promise<T>,
	opts: { staleIfError?: boolean; force?: boolean } = {}
): Promise<T> {
	const sqlite = rawDb();
	const row = sqlite.prepare('SELECT value, expires_at FROM provider_cache WHERE key = ?').get(key) as
		{ value: string; expires_at: number } | undefined;
	// `force` asks the source even when the saved answer is still current
	if (row && row.expires_at > Date.now() && !opts.force) return JSON.parse(row.value) as T;

	const pending = inflight.get(key);
	if (pending) return pending as Promise<T>;
	const p = (async () => {
		try {
			const value = await fn();
			sqlite
				.prepare('INSERT OR REPLACE INTO provider_cache (key, value, expires_at) VALUES (?, ?, ?)')
				.run(key, JSON.stringify(value), Date.now() + (typeof ttl === 'function' ? ttl(value) : ttl));
			return value;
		} catch (e) {
			const outage =
				(e instanceof ProviderError && e.code !== 'notfound') || (e as Error).name === 'TimeoutError';
			// A forced ask wants TMDB's answer now: an outage is reported, not covered up
			if (!opts.staleIfError || opts.force || !row || !outage) throw e;
			sqlite
				.prepare('UPDATE provider_cache SET expires_at = ? WHERE key = ?')
				.run(Date.now() + STALE_RETRY_MS, key);
			return JSON.parse(row.value) as T;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
	return p;
}

/** TV show and season answers back up the episode tracker when TMDB is down, so they are kept longer */
const KEEP_STALE_MS = 120 * 86_400_000;

export function pruneProviderCache() {
	const now = Date.now();
	rawDb()
		.prepare(
			`DELETE FROM provider_cache WHERE expires_at < ?
			 AND (expires_at < ? OR NOT (key LIKE 'tmdb:tv-air:%' OR key LIKE 'tmdb:tv-season:%'))`
		)
		.run(now, now - KEEP_STALE_MS);
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
		throw new ProviderError(`${init.label} could not be reached`, 502, 'unreachable');
	}
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError(`${init.label} rejected the API key (HTTP ${res.status})`, 502, 'auth');
		}
		if (res.status === 404) throw new ProviderError(`${init.label}: not found`, 404, 'notfound');
		if (res.status === 429) throw new ProviderError(`${init.label} is rate limiting requests`, 503, 'rate');
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
