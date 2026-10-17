import type { Category, Item } from '../db/schema';
import { searchSetlists, setlistfmEnabled, type SetlistQuery } from '../providers/setlistfm';
import { addLog, getItem, type LogInput } from './items';
import { SETLIST_SOURCE } from '$lib/kinds';
import type { SetlistEvent } from '$lib/types';

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

export function showPlace(e: SetlistEvent) {
	return [e.venue, e.city].filter(Boolean).join(', ');
}

/**
 * What happened when looking up the show for a new log:
 * attached (one show that day, saved with the log), several (the user picks), none (not on
 * setlist.fm yet), failed (setlist.fm unreachable), off (not a setlist list, or no key).
 */
export type ShowLookup = 'attached' | 'several' | 'none' | 'failed' | 'off';

/**
 * Adds a log, and for concert lists attaches the setlist.fm show from that day when there's
 * exactly one. The log is saved either way, so the date is never lost.
 */
export async function addLogWithShow(
	userId: number,
	itemId: number,
	category: Category,
	input: LogInput
): Promise<{ log: ReturnType<typeof addLog>; show: ShowLookup }> {
	// Logs are each person's own, so seeing the list is enough
	const item = getItem(userId, itemId);
	let show: ShowLookup = 'off';
	let entry = input;
	if (canFindSetlists(item, category) && !input.external) {
		try {
			const { events } = await searchSetlists({ artist: setlistArtist(item), date: input.date });
			if (events.length === 1) {
				const e = events[0];
				entry = { ...input, location: input.location || showPlace(e), external: { setlist: e } };
				show = 'attached';
			} else {
				show = events.length ? 'several' : 'none';
			}
		} catch {
			show = 'failed';
		}
	}
	return { log: addLog(userId, itemId, entry, category.statuses), show };
}

export const SHOW_LOOKUP_FAILED =
	"Saved, but setlist.fm couldn't be reached. Use “Find the setlist” on the show to try again.";

/** Where to go after adding: straight to picking the show when setlist.fm has several that day. */
export function afterAddPath(itemId: number, logId: number | null, show: ShowLookup | null) {
	if (show === 'several' && logId) return `/logs/${logId}/edit?pick=1`;
	if (show === 'failed') return `/items/${itemId}?${new URLSearchParams({ warn: SHOW_LOOKUP_FAILED })}`;
	return `/items/${itemId}`;
}
