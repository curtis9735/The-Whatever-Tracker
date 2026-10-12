import type { NormalizedMetadata, SearchResult } from '$lib/types';

export interface Provider {
	id: string;
	label: string;
	/** Kind keys this provider can return, e.g. `tmdb:movie` */
	kinds: string[];
	/** Environment variables that must be set for this provider */
	env: string[];
	/** Where to get credentials (shown in Settings → Integrations) */
	docsUrl: string;
	/** Per-request budget in ms (BGG is slow and strictly rate limited) */
	timeoutMs: number;
	enabled(): boolean;
	/** One uncached request with the current credentials; throws ProviderError on failure. */
	test(signal?: AbortSignal): Promise<void>;
	search(q: string, kinds: string[], signal: AbortSignal): Promise<SearchResult[]>;
	details(kind: string, id: string, signal?: AbortSignal): Promise<NormalizedMetadata>;
}
