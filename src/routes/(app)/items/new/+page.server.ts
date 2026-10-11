import { error, fail, redirect } from '@sveltejs/kit';
import { getCategoryById, getCategoryBySlug, listCategories } from '$lib/server/services/categories';
import { addImage, addLog, createItem, imageSourcesFromForm, listUserTags } from '$lib/server/services/items';
import { parseItemForm, parseLogForm, todayIso, wantsLog } from '$lib/server/forms';
import { ImageError } from '$lib/server/images/store';
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
		const log = wantsLog(form) ? parseLogForm(form, category, logFields) : null;
		if (log && !log.ok) return fail(400, { message: log.error });

		const item = createItem(userId, parsed.data, parsed.tags);
		const warnings: string[] = [];
		for (const src of imageSourcesFromForm(form, 'img_')) {
			try {
				await addImage(userId, { itemId: item.id }, src);
			} catch (e) {
				warnings.push(e instanceof ImageError ? e.message : 'One image could not be saved.');
			}
		}
		if (log?.ok) {
			const created = addLog(userId, item.id, log.data, category.statuses);
			for (const src of imageSourcesFromForm(form, 'logimg_')) {
				try {
					await addImage(userId, { logId: created.id }, src);
				} catch (e) {
					warnings.push(e instanceof ImageError ? e.message : 'One image could not be saved.');
				}
			}
		}
		redirect(303, `/items/${item.id}${warnings.length ? `?warn=${encodeURIComponent(warnings[0])}` : ''}`);
	}
};
