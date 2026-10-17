import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { editableCategories, getCategoryById } from '$lib/server/services/categories';
import { getItem, getItemTags, statusInList, tagSuggestions, updateItem } from '$lib/server/services/items';
import { parseItemForm } from '$lib/server/forms';
import { parseRatingInput } from '$lib/ratings';
import { isTrackedShow, ownersProgressFields, PROGRESS_KEYS } from '$lib/episodes';
import type { Actions, PageServerLoad } from './$types';

function itemId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Item not found');
	return id;
}

/** Lists the item can move to: its owner's lists that the viewer can edit (everyone's progress moves with it) */
function moveTargets(userId: number, ownerId: number) {
	const owners = new Set(
		db()
			.select({ id: schema.categories.id })
			.from(schema.categories)
			.where(eq(schema.categories.userId, ownerId))
			.all()
			.map((c) => c.id)
	);
	return editableCategories(userId).filter((c) => owners.has(c.id));
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.user!.id;
	const item = getItem(userId, itemId(params));
	// Shared to view: only their own status, rating, favorite and notes
	if (item.access === 'view') {
		return {
			item,
			canEdit: false,
			tracked: false,
			hideProgress: true,
			tags: [],
			allTags: [],
			lists: [],
			target: getCategoryById(userId, item.categoryId)
		};
	}
	const lists = moveTargets(userId, item.userId);
	// Allow previewing the form for another list before moving the item
	const requested = Number(url.searchParams.get('move'));
	const targetId = lists.some((c) => c.id === requested) ? requested : item.categoryId;
	const target = getCategoryById(userId, targetId, 'edit');
	const from = getCategoryById(userId, item.categoryId).category.statuses;
	return {
		// Moving to a list with other statuses: the menu starts on the closest one it has
		item: { ...item, status: statusInList(item.status, from, target.category.statuses) },
		canEdit: true,
		// Shows linked to TMDB track progress with check-ins, not these fields
		tracked: isTrackedShow(item),
		// A show's saved current season/episode is its owner's progress, so others don't see those fields
		hideProgress:
			isTrackedShow(item) ||
			(item.userId !== userId && ownersProgressFields(item, target.category.providerKinds)),
		tags: getItemTags(item.id),
		// Tags belong to the list's owner; others are offered the ones on lists they can see
		allTags: tagSuggestions(userId, item.userId),
		lists,
		target
	};
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const form = await request.formData();
		// Read after the form arrives, so a check-in made meanwhile isn't overwritten
		const item = getItem(userId, itemId(params));

		if (item.access === 'view') {
			const { category } = getCategoryById(userId, item.categoryId);
			const status = String(form.get('status') ?? '');
			const notes = String(form.get('notes') ?? '').trim();
			updateItem(userId, item.id, {
				status: category.statuses.some((s) => s.key === status) ? status : null,
				rating: parseRatingInput(form.get('rating')),
				favorite: form.get('favorite') === 'on',
				notes: notes ? notes.slice(0, 20000) : null
			});
			redirect(303, `/items/${item.id}`);
		}

		const categoryId = Number(form.get('categoryId')) || item.categoryId;
		const { category, itemFields } = getCategoryById(userId, categoryId, 'edit');
		const tracked = isTrackedShow(item);
		const hideProgress =
			tracked || (item.userId !== userId && ownersProgressFields(item, category.providerKinds));
		const shown = hideProgress ? itemFields.filter((f) => !PROGRESS_KEYS.includes(f.key)) : itemFields;
		const parsed = parseItemForm(form, category, shown);
		if (!parsed.ok) return fail(400, { message: parsed.error });

		// Keep values of fields this form doesn't show (e.g. after moving lists) unless overwritten
		const custom = { ...(categoryId === item.categoryId ? {} : item.custom), ...parsed.data.custom };
		for (const def of shown) if (!(def.key in parsed.data.custom)) delete custom[def.key];
		// A linked show's saved progress isn't on the form (it is used once, to mark episodes watched)
		if (hideProgress) for (const k of PROGRESS_KEYS) if (k in item.custom) custom[k] = item.custom[k];
		updateItem(userId, item.id, { ...parsed.data, custom }, parsed.tags);
		redirect(303, `/items/${item.id}`);
	}
};
