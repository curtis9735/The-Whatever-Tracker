import { error, fail, redirect } from '@sveltejs/kit';
import { getCategoryById } from '$lib/server/services/categories';
import { getItemTags, getOwnedItem, listUserTags, updateItem } from '$lib/server/services/items';
import { parseItemForm } from '$lib/server/forms';
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
		tags: getItemTags(item.id),
		allTags: listUserTags(userId),
		target
	};
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const form = await request.formData();
		const categoryId = Number(form.get('categoryId')) || item.categoryId;
		const { category, itemFields } = getCategoryById(userId, categoryId);
		const parsed = parseItemForm(form, category, itemFields);
		if (!parsed.ok) return fail(400, { message: parsed.error });

		// Keep values of fields this form doesn't show (e.g. after moving lists) unless overwritten
		const custom = { ...(categoryId === item.categoryId ? {} : item.custom), ...parsed.data.custom };
		for (const def of itemFields) if (!(def.key in parsed.data.custom)) delete custom[def.key];
		updateItem(userId, item.id, { ...parsed.data, custom }, parsed.tags);
		redirect(303, `/items/${item.id}`);
	}
};
