import { error, fail, redirect } from '@sveltejs/kit';
import { getCategoryById } from '$lib/server/services/categories';
import { getItemTags, getOwnedItem, listUserTags, updateItem } from '$lib/server/services/items';
import { parseItemForm } from '$lib/server/forms';
import { isTrackedShow, PROGRESS_KEYS } from '$lib/episodes';
import type { Actions, PageServerLoad } from './$types';

function itemId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Item not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.user!.id;
	const item = getOwnedItem(userId, itemId(params));
	// Allow previewing the form for another list before moving the item
	const targetId = Number(url.searchParams.get('move') ?? item.categoryId) || item.categoryId;
	const target = getCategoryById(userId, targetId);
	return {
		item,
		// Shows linked to TMDB track progress with check-ins, not these fields
		tracked: isTrackedShow(item),
		tags: getItemTags(item.id),
		allTags: listUserTags(userId),
		target
	};
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		// Read after the form arrives, so a check-in made meanwhile isn't overwritten
		const item = getOwnedItem(userId, itemId(params));
		const categoryId = Number(form.get('categoryId')) || item.categoryId;
		const { category, itemFields } = getCategoryById(userId, categoryId);
		const tracked = isTrackedShow(item);
		const shown = tracked ? itemFields.filter((f) => !PROGRESS_KEYS.includes(f.key)) : itemFields;
		const parsed = parseItemForm(form, category, shown);
		if (!parsed.ok) return fail(400, { message: parsed.error });

		// Keep values of fields this form doesn't show (e.g. after moving lists) unless overwritten
		const custom = { ...(categoryId === item.categoryId ? {} : item.custom), ...parsed.data.custom };
		for (const def of shown) if (!(def.key in parsed.data.custom)) delete custom[def.key];
		// A linked show's saved progress isn't on the form (it is used once, to mark episodes watched)
		if (tracked) for (const k of PROGRESS_KEYS) if (k in item.custom) custom[k] = item.custom[k];
		updateItem(userId, item.id, { ...parsed.data, custom }, parsed.tags);
		redirect(303, `/items/${item.id}`);
	}
};
