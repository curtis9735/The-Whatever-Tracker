import { error, json } from '@sveltejs/kit';
import { getItem } from '$lib/server/services/items';
import { tracksOnDay } from '$lib/server/services/tracks';
import { isIsoDate } from '$lib/journal';
import type { RequestHandler } from './$types';

/**
 * The tracks the signed-in person played of this album on one day, from their own last.fm plays.
 * Loaded when a log's track list is opened, so the item page doesn't carry every day's list.
 */
export const GET: RequestHandler = ({ locals, params, url }) => {
	const id = Number(params.id);
	const date = url.searchParams.get('date') ?? '';
	if (!Number.isInteger(id) || id <= 0 || !isIsoDate(date)) error(404, 'Not found');
	const item = getItem(locals.user!.id, id); // 404 unless the item's list is theirs or shared with them
	return json(
		{ tracks: tracksOnDay(locals.user!.id, item.id, item.metadata, date) },
		{ headers: { 'Cache-Control': 'private, no-store' } }
	);
};
