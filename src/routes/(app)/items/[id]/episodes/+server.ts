import { error, json } from '@sveltejs/kit';
import { todayIso } from '$lib/server/forms';
import { seasonView } from '$lib/server/services/episodes';
import { validEpisode } from '$lib/episodes';
import type { RequestHandler } from './$types';

/** One season of a show: TMDB's episodes with this user's plays of each */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = Number(params.id);
	const season = Number(url.searchParams.get('season'));
	if (!Number.isInteger(id) || id <= 0 || !validEpisode(season, 1)) error(404, 'Not found');
	return json(await seasonView(locals.user!.id, id, season, todayIso()));
};
