import type { Category, Item } from '../db/schema';
import { setlistfmEnabled, type SetlistQuery } from '../providers/setlistfm';

/** Items that are performers: MusicBrainz artists, or anything in a list meant for concerts. */
export function isConcertItem(item: Item, category: Category) {
	return (
		(item.provider === 'musicbrainz' && item.providerKind === 'artist') ||
		category.providerKinds.includes('musicbrainz:artist') ||
		category.templateKey === 'concerts'
	);
}

export function canFindSetlists(item: Item, category: Category) {
	return setlistfmEnabled() && isConcertItem(item, category);
}

/** Exact MusicBrainz match when we have one; otherwise search setlist.fm by the item's name. */
export function setlistArtist(item: Item): SetlistQuery['artist'] {
	if (item.provider === 'musicbrainz' && item.providerKind === 'artist' && item.providerId) {
		return { mbid: item.providerId };
	}
	return { name: item.title };
}
