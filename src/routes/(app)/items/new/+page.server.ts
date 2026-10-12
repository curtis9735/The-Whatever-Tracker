import { error, fail, redirect } from '@sveltejs/kit';
import { getCategoryById, getCategoryBySlug, listCategories } from '$lib/server/services/categories';
import { addImage, addLog, createItem, imageSourcesFromForm, listUserTags } from '$lib/server/services/items';
import { firstLogDate, parseItemForm, parseLogForm, todayIso } from '$lib/server/forms';
import { canFindSetlists } from '$lib/server/services/concerts';
import { ImageError } from '$lib/server/images/store';
import { findExisting, linkToProvider, lookupFailure, parseMatch } from '$lib/server/services/provider-items';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.user!.id;
	const categories = listCategories(userId);
	if (!categories.length) redirect(303, '/categories/new');
	const slug = url.searchParams.get('category');
	// Scanned products belong in a hand-made list (whiskey, sauces…), not a movie or game list
	const fallback =
		(url.searchParams.has('barcode') && categories.find((c) => c.providerKinds.length === 0)) ||
		categories[0];
	const chosen = slug ? getCategoryBySlug(userId, slug) : getCategoryById(userId, fallback.id);
	const sp = url.searchParams;
	return {
		chosen,
		allTags: listUserTags(userId),
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
		const { category, itemFields, logFields } = getCategoryById(userId, categoryId);

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
			if (existing) {
				return fail(400, { message: 'That one is already in your library.', existingId: existing });
			}
		}

		const item = createItem(userId, parsed.data, parsed.tags);
		const warnings: string[] = [];
		if (match) {
			// Before the user's photos, so the poster becomes the cover
			try {
				await linkToProvider(userId, item.id, match);
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
		const params = new URLSearchParams();
		if (log?.ok && canFindSetlists(item, category)) {
			// Concerts: the log is made on the artist's page, where setlist.fm fills in venue and songs
			params.set('log', log.data.date);
		} else if (log?.ok) {
			// One rating on the form: the item's rating is also this first log's rating
			const created = addLog(userId, item.id, { ...log.data, rating: parsed.data.rating }, category.statuses);
			for (const src of imageSourcesFromForm(form, 'logimg_')) {
				try {
					await addImage(userId, { logId: created.id }, src);
				} catch (e) {
					warnings.push(e instanceof ImageError ? e.message : 'One image could not be saved.');
				}
			}
		}
		if (warnings.length) params.set('warn', warnings[0]);
		redirect(303, `/items/${item.id}${params.size ? `?${params}` : ''}`);
	}
};
