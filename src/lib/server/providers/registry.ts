import { bgg } from './bgg';
import { igdb } from './igdb';
import { lastfm } from './lastfm';
import { musicbrainz } from './musicbrainz';
import { tmdb } from './tmdb';
import type { Provider } from './types';

export const PROVIDERS: Provider[] = [tmdb, igdb, bgg, musicbrainz, lastfm];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string) {
	return BY_ID.get(id) ?? null;
}

/** Kind keys that can actually be searched right now (provider has credentials). */
export function enabledKinds(): Set<string> {
	return new Set(PROVIDERS.filter((p) => p.enabled()).flatMap((p) => p.kinds));
}

export function splitKindKey(kindKey: string) {
	const [provider, kind] = kindKey.split(':');
	return { provider, kind };
}
