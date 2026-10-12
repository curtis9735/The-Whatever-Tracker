import type { Category, Item } from '../db/schema';
import { setlistfmEnabled, type SetlistQuery } from '../providers/setlistfm';
import { SETLIST_SOURCE } from '$lib/kinds';

/** A list opts in to setlist lookups under List settings → Sources (on by default for Concerts). */
export function listUsesSetlists(category: Pick<Category, 'providerKinds'>) {
	return category.providerKinds.includes(SETLIST_SOURCE);
}

export function canFindSetlists(_item: Item, category: Category) {
	return setlistfmEnabled() && listUsesSetlists(category);
}

/** Exact MusicBrainz match when we have one; otherwise search setlist.fm by the item's name. */
export function setlistArtist(item: Item): SetlistQuery['artist'] {
	if (item.provider === 'musicbrainz' && item.providerKind === 'artist' && item.providerId) {
		return { mbid: item.providerId };
	}
	return { name: item.title };
}
