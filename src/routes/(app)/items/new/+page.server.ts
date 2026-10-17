import { error, fail, redirect } from '@sveltejs/kit';
import { editableCategories, getCategoryById, getCategoryBySlug } from '$lib/server/services/categories';
import {
	addImage,
	createItem,
	getItem,
	imageSourcesFromForm,
	tagSuggestions
} from '$lib/server/services/items';
import { firstLogDate, parseEpisodePick, parseItemForm, parseLogForm, todayIso } from '$lib/server/forms';
import {
	applySavedProgressNow,
	episodeGuide,
	insertWatches,
	tmdbProblem
} from '$lib/server/services/episodes';
import { addLogWithShow, afterAddPath, SHOW_LOOKUP_FAILED } from '$lib/server/services/concerts';
import { ImageError } from '$lib/server/images/store';
import { findExisting, linkToProvider, lookupFailure, parseMatch } from '$lib/server/services/provider-items';
import type { Actions, PageServerLoad } from './$types';

/** "Already have it": on one of the viewer's lists, or on a list shared with them */
function alreadyHave(userId: number, existingId: number) {
	const { category } = getCategoryById(userId, getItem(userId, existingId).categoryId);
	return category.access === 'owner'
		? 'That one is already in your library.'
		: `That one is already in ${category.ownerName}'s library.`;
}

/**
 * Someone adding a show to a list shared with them: the last episode they watched marks it and every
 * aired episode before it, for them (progress saved on the item would be the list owner's).
 */
async function markWatchedUpTo(
	userId: number,
	itemId: number,
	tmdbId: string,
	upTo: { season: number; episode: number }
) {
	const guide = await episodeGuide(tmdbId, todayIso());
	const plays = guide.seasons
		.filter((s) => s.number > 0 && s.number <= upTo.season)
		.flatMap((s) =>
			s.aired
				.filter((e) => s.number < upTo.season || e <= upTo.episode)
				.map((episode) => ({ season: s.number, episode }))
		);
	insertWatches(userId, itemId, plays);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.user!.id;
	// The viewer's own lists, and lists shared with them to edit
	const lists = editableCategories(userId);
	if (!lists.length) redirect(303, '/categories/new');
	const slug = url.searchParams.get('category');
	// Scanned products belong in a hand-made list (whiskey, sauces…), not a movie or game list
	const fallback =
		(url.searchParams.has('barcode') && lists.find((c) => c.providerKinds.length === 0)) || lists[0];
	const chosen = slug
		? getCategoryBySlug(userId, slug, 'edit')
		: getCategoryById(userId, fallback.id, 'edit');
	const sp = url.searchParams;
	return {
		chosen,
		lists,
		// Tags belong to the list's owner; others are offered the ones on lists they can see
		allTags: tagSuggestions(userId, chosen.category.userId),
		today: todayIso(),
		defaults: {
			title: sp.get('title') ?? '',
			subtitle: sp.get('subtitle') ?? '',
			barcode: sp.get('barcode') ?? '',
			image: sp.get('image') ?? ''
		}
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		const categoryId = Number(form.get('categoryId'));
		if (!categoryId) error(400, 'Missing list');
		const { category, itemFields, logFields } = getCategoryById(userId, categoryId, 'edit');

		const parsed = parseItemForm(form, category, itemFields);
		if (!parsed.ok) return fail(400, { message: parsed.error });
		// A finished status (Completed, Tasted, Seen…) records when it happened as the first log
		const when = firstLogDate(form, category.statuses, parsed.data.status ?? null);
		const log = when ? parseLogForm(form, category, logFields) : null;
		if (log && !log.ok) return fail(400, { message: log.error });

		// A match picked from TMDB etc.: refuse duplicates before creating anything
		const match = parseMatch(form);
		if (match) {
			const existing = findExisting(userId, match.provider, match.kind, match.id);
			if (existing) return fail(400, { message: alreadyHave(userId, existing), existingId: existing });
			// An owner has each source entry once, also on lists that aren't shared with the viewer
			if (
				category.userId !== userId &&
				findExisting(category.userId, match.provider, match.kind, match.id, { ownOnly: true })
			) {
				return fail(400, {
					message: `${category.ownerName} already has this in a list that isn't shared with you.`
				});
			}
		}

		// A show from TMDB: the last episode watched marks it and every episode before it. Saved with
		// the show first, so it isn't lost if TMDB doesn't answer now (the show's page tries again).
		// Saved progress is the list owner's: on someone else's list it's marked for the viewer instead.
		const progress =
			match?.provider === 'tmdb' && match.kind === 'tv' ? parseEpisodePick(form, 'progress_') : null;
		if (progress === 'invalid') return fail(400, { message: 'Pick the last episode you watched.' });
		const theirs = category.userId === userId;
		if (progress && theirs) {
			parsed.data.custom = {
				...parsed.data.custom,
				current_season: progress.season,
				current_episode: progress.episode
			};
		}

		const item = createItem(userId, parsed.data, parsed.tags);
		const warnings: string[] = [];
		if (match) {
			// Before the user's photos, so the poster becomes the cover
			try {
				await linkToProvider(userId, item.id, match);
				if (progress && theirs) await applySavedProgressNow(userId, item.id, todayIso()).catch(() => null);
				else if (progress) {
					await markWatchedUpTo(userId, item.id, match.id, progress).catch((e) =>
						warnings.push(`Saved, but your episodes couldn't be marked: ${tmdbProblem(e)}`)
					);
				}
			} catch (e) {
				warnings.push(`Saved, but the details couldn't be loaded: ${lookupFailure(e)}`);
			}
		}
		for (const src of imageSourcesFromForm(form, 'img_')) {
			try {
				await addImage(userId, { itemId: item.id }, src);
			} catch (e) {
				warnings.push(e instanceof ImageError ? e.message : 'One image could not be saved.');
			}
		}
		if (log?.ok) {
			// One rating on the form: the item's rating is also this first log's rating.
			// Concerts: the setlist.fm show from that day is attached when there's exactly one.
			const first = await addLogWithShow(userId, item.id, category, {
				...log.data,
				rating: parsed.data.rating
			});
			for (const src of imageSourcesFromForm(form, 'logimg_')) {
				try {
					await addImage(userId, { logId: first.log.id }, src);
				} catch (e) {
					warnings.push(e instanceof ImageError ? e.message : 'One image could not be saved.');
				}
			}
			if (first.show === 'several') redirect(303, afterAddPath(item.id, first.log.id, first.show));
			if (first.show === 'failed') warnings.push(SHOW_LOOKUP_FAILED);
		}
		redirect(
			303,
			`/items/${item.id}${warnings.length ? `?${new URLSearchParams({ warn: warnings[0] })}` : ''}`
		);
	}
};
