import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import {
	addImage,
	addLog,
	deleteImage,
	deleteItem,
	deleteLog,
	getItemDetail,
	getOwnedItem,
	getOwnedLog,
	imageSourcesFromForm,
	setCover,
	updateItem,
	updateLog
} from '$lib/server/services/items';
import { fetchSetlist } from '$lib/server/providers/setlistfm';
import { ProviderError } from '$lib/server/providers/util';
import type { SetlistEvent } from '$lib/types';
import { getCategoryById } from '$lib/server/services/categories';
import {
	linkToProvider,
	lookupFailure,
	MatchError,
	parseMatch,
	refreshMetadata
} from '$lib/server/services/provider-items';
import { parseEpisodePick, parseLogForm, todayIso } from '$lib/server/forms';
import { ImageError } from '$lib/server/images/store';
import { canFindSetlists } from '$lib/server/services/concerts';
import { parseRatingInput } from '$lib/ratings';
import { isTrackedShow } from '$lib/episodes';
import { isIsoDate } from '$lib/journal';
import {
	EpisodeError,
	loadTracker,
	markRemaining,
	markSeason,
	removePlay,
	restorePlays,
	tmdbProblem,
	trackedShow,
	unmarkSeason,
	unwatchEpisode,
	watchEpisode,
	type UndatedPlay
} from '$lib/server/services/episodes';
import type { Actions, PageServerLoad } from './$types';

function itemId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Item not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const detail = getItemDetail(locals.user!.id, itemId(params));
	const today = todayIso();
	const tracked = isTrackedShow(detail.item);
	return {
		...detail,
		today,
		tracked,
		// Episodes come from TMDB: streamed, so the rest of the page never waits for it
		tracker: tracked
			? loadTracker(locals.user!.id, trackedShow(locals.user!.id, detail.item.id), today)
			: null,
		canSetlist: canFindSetlists(detail.item, detail.category),
		warn: url.searchParams.get('warn')
	};
};

/** "When did you watch it?": today, another day (a log with that date), or not known (no log) */
function whenLog(form: FormData, today: string): { date: string } | null | 'invalid' {
	const when = String(form.get('when') ?? 'today');
	if (when === 'unknown') return null;
	if (when === 'date') {
		const date = String(form.get('date') ?? '');
		return isIsoDate(date) ? { date } : 'invalid';
	}
	return { date: today };
}

/**
 * Undo of a check-in also takes back the status change it made (`status_set`, from `status_was`),
 * unless the status has been changed since.
 */
function revertStatus(userId: number, id: number, form: FormData) {
	if (!form.has('status_set')) return;
	const item = getOwnedItem(userId, id);
	if (item.status !== String(form.get('status_set'))) return;
	const was = String(form.get('status_was') ?? '');
	const { category } = getCategoryById(userId, item.categoryId);
	if (was && !category.statuses.some((s) => s.key === was)) return;
	updateItem(userId, item.id, { status: was || null });
}

function episodeFailure(e: unknown) {
	if (e instanceof EpisodeError) return fail(400, { episodeError: e.message });
	if (e instanceof ProviderError || (e as Error).name === 'TimeoutError') {
		return fail(502, { episodeError: tmdbProblem(e) });
	}
	throw e;
}

async function saveImages(
	userId: number,
	target: { itemId: number } | { logId: number },
	form: FormData,
	prefix: string
) {
	const warnings: string[] = [];
	for (const src of imageSourcesFromForm(form, prefix)) {
		try {
			await addImage(userId, target, src);
		} catch (e) {
			warnings.push(
				e instanceof ImageError || e instanceof Error ? e.message : 'An image could not be saved.'
			);
		}
	}
	return warnings;
}

export const actions: Actions = {
	status: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const { category } = getCategoryById(userId, item.categoryId);
		const status = String((await request.formData()).get('status') ?? '');
		if (!category.statuses.some((s) => s.key === status)) return fail(400, { message: 'Unknown status' });
		updateItem(userId, item.id, { status });
	},

	favorite: async ({ locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		updateItem(userId, item.id, { favorite: !item.favorite });
	},

	rate: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const rating = parseRatingInput((await request.formData()).get('rating'));
		updateItem(userId, item.id, { rating });
	},

	addLog: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const { category, logFields } = getCategoryById(userId, item.categoryId);
		const form = await request.formData();
		const parsed = parseLogForm(form, category, logFields);
		if (!parsed.ok) return fail(400, { logError: parsed.error });
		// Shows linked to TMDB: the log can be for an episode
		const pick = isTrackedShow(item) ? parseEpisodePick(form) : null;
		if (pick === 'invalid') return fail(400, { logError: 'Pick a season and episode.' });
		let logId: number;
		let checkedIn = null;
		if (pick) {
			try {
				checkedIn = await watchEpisode(userId, item.id, pick, parsed.data, todayIso());
			} catch (e) {
				if (e instanceof EpisodeError) return fail(400, { logError: e.message });
				throw e;
			}
			logId = checkedIn.logId!;
		} else {
			logId = addLog(userId, item.id, parsed.data, category.statuses).id;
		}
		const warnings = checkedIn?.duplicate ? [] : await saveImages(userId, { logId }, form, 'logimg_');
		return { logAdded: true, checkedIn, warning: warnings[0] ?? null };
	},

	/** One episode: today, another day, or "don't remember when" (marked watched, no log) */
	checkIn: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const today = todayIso();
		const log = whenLog(form, today);
		if (log === 'invalid') return fail(400, { episodeError: 'Pick a valid date.' });
		const pick = { season: Number(form.get('season')), episode: Number(form.get('episode')) };
		try {
			return { checkedIn: await watchEpisode(userId, itemId(params), pick, log, today, { quick: true }) };
		} catch (e) {
			return episodeFailure(e);
		}
	},

	/** Every aired episode of a season not watched yet; with a date, as one log */
	markSeason: async ({ request, locals, params }) => {
		const form = await request.formData();
		const today = todayIso();
		const log = whenLog(form, today);
		if (log === 'invalid') return fail(400, { episodeError: 'Pick a valid date.' });
		const season = Number(form.get('season'));
		try {
			const r = await markSeason(locals.user!.id, itemId(params), season, log, today);
			return { marked: { season, ...r } };
		} catch (e) {
			return episodeFailure(e);
		}
	},

	/** Every aired episode not watched yet, without a date (e.g. after setting the show to Completed) */
	markRemaining: async ({ locals, params }) => {
		try {
			const r = await markRemaining(locals.user!.id, itemId(params), todayIso());
			return { marked: { season: null, ...r } };
		} catch (e) {
			return episodeFailure(e);
		}
	},

	/** Un-watches an episode's plays that have no log; returns them for Undo */
	unwatch: async ({ request, locals, params }) => {
		const form = await request.formData();
		const season = Number(form.get('season'));
		const episode = Number(form.get('episode'));
		const r = unwatchEpisode(locals.user!.id, itemId(params), season, episode);
		return { unwatched: { season, episode, ...r } };
	},

	/** Undo for unwatch */
	restore: async ({ request, locals, params }) => {
		const form = await request.formData();
		let plays: UndatedPlay[] = [];
		try {
			const raw = JSON.parse(String(form.get('plays') ?? '[]')) as unknown[];
			plays = raw.map((p) => {
				const { id, title, watchedAt, createdAt } = (p ?? {}) as Record<string, unknown>;
				const whole = (n: unknown) => (Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : null);
				return {
					id: whole(id),
					title: typeof title === 'string' ? title.slice(0, 300) : null,
					watchedAt: typeof watchedAt === 'string' && isIsoDate(watchedAt) ? watchedAt : null,
					createdAt: whole(createdAt)
				};
			});
		} catch {
			return fail(400, { episodeError: 'Nothing to put back.' });
		}
		restorePlays(
			locals.user!.id,
			itemId(params),
			Number(form.get('season')),
			Number(form.get('episode')),
			plays
		);
	},

	unmarkSeason: async ({ request, locals, params }) => {
		const season = Number((await request.formData()).get('season'));
		const r = unmarkSeason(locals.user!.id, itemId(params), season);
		return { unmarked: { season, ...r } };
	},

	/** One play; a check-in goes with its log */
	removePlay: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		trackedShow(userId, itemId(params));
		const form = await request.formData();
		await removePlay(userId, Number(form.get('watchId')), itemId(params));
		revertStatus(userId, itemId(params), form);
		return { removedPlay: true };
	},

	/** Re-fetches a log's setlist from setlist.fm (songs are often added in the days after a show). */
	refreshSetlist: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const log = getOwnedLog(userId, Number((await request.formData()).get('logId')));
		const current = (log.external as { setlist?: SetlistEvent } | null)?.setlist;
		if (log.itemId !== item.id || !current) return fail(400, { warning: 'This log has no setlist.' });
		try {
			const fresh = await fetchSetlist(current.id);
			updateLog(userId, log.id, { ...log, external: { ...log.external, setlist: fresh } });
		} catch (e) {
			return fail(502, {
				warning: e instanceof ProviderError ? e.message : 'setlist.fm could not be reached'
			});
		}
	},

	deleteLog: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		try {
			await deleteLog(userId, Number(form.get('logId')));
		} catch (e) {
			// Already deleted (a second tap on Undo)
			if (!isHttpError(e, 404)) throw e;
		}
		revertStatus(userId, itemId(params), form);
	},

	addImages: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const form = await request.formData();
		const warnings = await saveImages(userId, { itemId: item.id }, form, 'img_');
		if (warnings.length) return fail(400, { imageError: warnings[0] });
		return { imagesAdded: true };
	},

	deleteImage: async ({ request, locals }) => {
		const imageId = Number((await request.formData()).get('imageId'));
		await deleteImage(locals.user!.id, imageId);
	},

	cover: async ({ request, locals, params }) => {
		const imageId = Number((await request.formData()).get('imageId'));
		setCover(locals.user!.id, itemId(params), imageId);
	},

	refresh: async ({ locals, params }) => {
		try {
			await refreshMetadata(locals.user!.id, itemId(params));
			return { refreshed: true };
		} catch (e) {
			const message = (e as { body?: { message?: string } }).body?.message ?? 'Could not refresh metadata';
			return fail(502, { message });
		}
	},

	/** Links an item added by hand to a TMDB/IGDB/… entry, pulling the poster and details. */
	link: async ({ request, locals, params }) => {
		const match = parseMatch(await request.formData());
		if (!match) return fail(400, { linkError: 'Pick one of the matches first.' });
		try {
			await linkToProvider(locals.user!.id, itemId(params), match);
			return { linked: true };
		} catch (e) {
			if (e instanceof MatchError) return fail(400, { linkError: e.message, existingId: e.existingId });
			return fail(502, { linkError: lookupFailure(e) });
		}
	},

	delete: async ({ locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const { category } = getCategoryById(userId, item.categoryId);
		await deleteItem(userId, item.id);
		redirect(303, `/c/${category.slug}`);
	}
};
