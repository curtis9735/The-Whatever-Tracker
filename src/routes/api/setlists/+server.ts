import { error, json } from '@sveltejs/kit';
import { searchSetlists, setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { ProviderError } from '$lib/server/providers/util';
import { getOwnedItem } from '$lib/server/services/items';
import { getCategoryById } from '$lib/server/services/categories';
import { listUsesSetlists, setlistArtist } from '$lib/server/services/concerts';
import type { RequestHandler } from './$types';

/** setlist.fm shows for the performer behind an item, filtered by date/year, city and venue. */
export const GET: RequestHandler = async ({ locals, url, request }) => {
	if (!setlistfmEnabled()) error(503, 'setlist.fm is not connected (Me → Integrations)');
	const userId = locals.user!.id;
	const item = getOwnedItem(userId, Number(url.searchParams.get('item')));
	const { category } = getCategoryById(userId, item.categoryId);
	if (!listUsesSetlists(category)) {
		error(400, `Turn on “Concert setlists” in the ${category.name} list settings first`);
	}
	const sp = url.searchParams;
	try {
		const data = await searchSetlists(
			{
				artist: setlistArtist(item),
				date: sp.get('date') ?? undefined,
				year: sp.get('year') ?? undefined,
				city: sp.get('city') ?? undefined,
				venue: sp.get('venue') ?? undefined,
				page: Number(sp.get('page') ?? 1) || 1
			},
			request.signal
		);
		return json(data);
	} catch (e) {
		if (e instanceof ProviderError) error(e.status >= 500 ? e.status : 502, e.message);
		throw e;
	}
};
