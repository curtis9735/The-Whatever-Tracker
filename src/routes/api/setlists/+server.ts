import { error, json } from '@sveltejs/kit';
import { searchSetlists, setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { ProviderError } from '$lib/server/providers/util';
import { getOwnedItem } from '$lib/server/services/items';
import type { RequestHandler } from './$types';

/** Setlists for the artist behind a Concerts item, filtered by date, year or city. */
export const GET: RequestHandler = async ({ locals, url, request }) => {
	if (!setlistfmEnabled()) error(503, 'setlist.fm is not configured (SETLISTFM_API_KEY)');
	const item = getOwnedItem(locals.user!.id, Number(url.searchParams.get('item')));
	if (item.provider !== 'musicbrainz' || item.providerKind !== 'artist' || !item.providerId) {
		error(400, 'Setlists need an artist from MusicBrainz');
	}
	try {
		const data = await searchSetlists(
			item.providerId,
			{
				date: url.searchParams.get('date') ?? undefined,
				year: url.searchParams.get('year') ?? undefined,
				city: url.searchParams.get('city') ?? undefined,
				page: Number(url.searchParams.get('page') ?? 1) || 1
			},
			request.signal
		);
		return json(data);
	} catch (e) {
		if (e instanceof ProviderError) error(e.status >= 500 ? e.status : 502, e.message);
		throw e;
	}
};
