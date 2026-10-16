import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { getCategoryById } from '$lib/server/services/categories';
import {
	addImage,
	deleteImage,
	deleteLog,
	getOwnedItem,
	getOwnedLog,
	imageSourcesFromForm,
	updateLog
} from '$lib/server/services/items';
import { parseEpisodePick, parseLogForm, todayIso } from '$lib/server/forms';
import { isTrackedShow } from '$lib/episodes';
import {
	EpisodeError,
	episodeForLog,
	episodeGuide,
	logPlays,
	setLogEpisode,
	trackedShow
} from '$lib/server/services/episodes';
import { ImageError } from '$lib/server/images/store';
import { canFindSetlists } from '$lib/server/services/concerts';
import type { Actions, PageServerLoad } from './$types';

function logId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Log not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.user!.id;
	const log = getOwnedLog(userId, logId(params));
	const item = getOwnedItem(userId, log.itemId);
	const cat = getCategoryById(userId, item.categoryId);
	const images = db()
		.select()
		.from(schema.images)
		.where(eq(schema.images.logId, log.id))
		.orderBy(asc(schema.images.id))
		.all();
	const tracked = isTrackedShow(item);
	const today = todayIso();
	return {
		log,
		item,
		...cat,
		images,
		today,
		tracked,
		/** The episodes this log is for (more than one: a whole season marked at once) */
		plays: tracked ? logPlays(log.id) : [],
		// For the episode picker; streamed, and empty when TMDB can't be reached
		seasons: tracked
			? episodeGuide(item.providerId!, today)
					.then((g) =>
						g.seasons.map((s) => ({ number: s.number, aired: s.aired.length, episodeCount: s.episodeCount }))
					)
					.catch(() => [])
			: null,
		canSetlist: canFindSetlists(item, cat.category),
		// Just added, and setlist.fm has more than one show for the artist that day
		pick: url.searchParams.has('pick')
	};
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const log = getOwnedLog(userId, logId(params));
		const item = getOwnedItem(userId, log.itemId);
		const { category, logFields } = getCategoryById(userId, item.categoryId);
		const form = await request.formData();
		const parsed = parseLogForm(form, category, logFields);
		if (!parsed.ok) return fail(400, { message: parsed.error });
		// Shows linked to TMDB: the episode picker posts a marker, so "no episode" can be told from "not shown"
		let withLog: ((id: number) => void) | undefined;
		if (isTrackedShow(item) && form.has('log_episode_set')) {
			const pick = parseEpisodePick(form);
			if (pick === 'invalid') return fail(400, { message: 'Pick a season and episode.' });
			const current = logPlays(log.id);
			// Unchanged: left alone (even if TMDB no longer lists it)
			const same =
				pick &&
				current.length === 1 &&
				current[0].season === pick.season &&
				current[0].episode === pick.episode;
			if (!same) {
				let ep = null;
				try {
					ep = pick ? await episodeForLog(trackedShow(userId, item.id), pick) : null;
				} catch (e) {
					if (e instanceof EpisodeError) return fail(400, { message: e.message });
					throw e;
				}
				withLog = (id) => setLogEpisode(userId, item.id, id, ep);
			}
		}
		updateLog(userId, log.id, parsed.data, { withLog });
		for (const src of imageSourcesFromForm(form, 'logimg_')) {
			try {
				await addImage(userId, { logId: log.id }, src);
			} catch (e) {
				return fail(400, {
					message: e instanceof ImageError || e instanceof Error ? e.message : 'Image failed'
				});
			}
		}
		redirect(303, `/items/${item.id}`);
	},
	deleteImage: async ({ request, locals }) => {
		await deleteImage(locals.user!.id, Number((await request.formData()).get('imageId')));
	},
	delete: async ({ locals, params }) => {
		const log = await deleteLog(locals.user!.id, logId(params));
		redirect(303, `/items/${log.itemId}`);
	}
};
