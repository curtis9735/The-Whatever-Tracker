import { error, json } from '@sveltejs/kit';
import { todayIso } from '$lib/server/forms';
import { episodeGuide, seasonEpisodes, tmdbProblem } from '$lib/server/services/episodes';
import { validEpisode } from '$lib/episodes';
import { ProviderError } from '$lib/server/providers/util';
import type { RequestHandler } from './$types';

/**
 * A TMDB show's seasons (which episodes are out), or with `?season=N` that season's episodes:
 * for picking the last episode watched when adding a show.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	if (!/^\d{1,12}$/.test(params.id)) error(404, 'Not found');
	const today = todayIso();
	const season = url.searchParams.get('season');
	try {
		if (season !== null) {
			if (!validEpisode(Number(season), 1)) error(400, 'Bad season');
			return json({ episodes: await seasonEpisodes(params.id, Number(season), today) });
		}
		const guide = await episodeGuide(params.id, today);
		return json({
			ended: guide.ended,
			lastAired: guide.lastAired,
			seasons: guide.seasons.map((s) => ({
				number: s.number,
				aired: s.aired.length,
				episodeCount: s.episodeCount
			}))
		});
	} catch (e) {
		if (e instanceof ProviderError) {
			return json({ message: tmdbProblem(e) }, { status: e.code === 'notfound' ? 404 : 502 });
		}
		if ((e as Error).name === 'TimeoutError') return json({ message: tmdbProblem(e) }, { status: 504 });
		throw e;
	}
};
