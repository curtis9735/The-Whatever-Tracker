import { error, json } from '@sveltejs/kit';
import { getProvider } from '$lib/server/providers/registry';
import { ProviderError, withTimeout } from '$lib/server/providers/util';
import { libraryMatches } from '$lib/server/search/local';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	const provider = getProvider(params.provider);
	if (!provider) error(404, 'Unknown source');
	if (!provider.enabled()) error(503, `${provider.label} is not configured`);

	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
	if (q.length < 2) return json({ results: [], inLibrary: {} });
	const requested = (url.searchParams.get('kinds') ?? '').split(',').filter(Boolean);
	const kinds = requested.length ? provider.kinds.filter((k) => requested.includes(k)) : provider.kinds;
	if (!kinds.length) return json({ results: [], inLibrary: {} });

	try {
		// request.signal aborts when the user keeps typing and the browser cancels this call
		const results = await provider.search(q, kinds, withTimeout(request.signal, provider.timeoutMs));
		const inLibrary = libraryMatches(locals.user!.id, results);
		return json({ results, inLibrary });
	} catch (e) {
		const name = (e as Error).name;
		if (name === 'AbortError' || name === 'TimeoutError') {
			error(504, `${provider.label} took too long to answer`);
		}
		if (e instanceof ProviderError) error(e.status >= 500 ? e.status : 502, e.message);
		console.error(`[search:${provider.id}]`, e);
		error(502, `${provider.label} search failed`);
	}
};
