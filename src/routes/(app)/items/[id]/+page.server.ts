import { error, fail, redirect } from '@sveltejs/kit';
import {
	addImage,
	addLog,
	deleteImage,
	deleteItem,
	deleteLog,
	getItemDetail,
	getOwnedItem,
	imageSourcesFromForm,
	setCover,
	updateItem
} from '$lib/server/services/items';
import { getCategoryById } from '$lib/server/services/categories';
import {
	linkToProvider,
	lookupFailure,
	MatchError,
	parseMatch,
	refreshMetadata
} from '$lib/server/services/provider-items';
import { parseLogForm, todayIso } from '$lib/server/forms';
import { ImageError } from '$lib/server/images/store';
import { canFindSetlists } from '$lib/server/services/concerts';
import { parseRatingInput } from '$lib/ratings';
import type { Actions, PageServerLoad } from './$types';

function itemId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Item not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const detail = getItemDetail(locals.user!.id, itemId(params));
	// ?log=YYYY-MM-DD opens the "Add log" form for that day (used right after adding an artist from search)
	const logParam = url.searchParams.get('log');
	return {
		...detail,
		today: todayIso(),
		canSetlist: canFindSetlists(detail.item, detail.category),
		openLogDate: logParam && /^\d{4}-\d{2}-\d{2}$/.test(logParam) ? logParam : null,
		warn: url.searchParams.get('warn')
	};
};

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
		const { category } = getCategoryById(userId, item.categoryId);
		const rating = parseRatingInput((await request.formData()).get('rating'), category.ratingScale);
		updateItem(userId, item.id, { rating });
	},

	addLog: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const item = getOwnedItem(userId, itemId(params));
		const { category, logFields } = getCategoryById(userId, item.categoryId);
		const form = await request.formData();
		const parsed = parseLogForm(form, category, logFields);
		if (!parsed.ok) return fail(400, { logError: parsed.error });
		const log = addLog(userId, item.id, parsed.data, category.statuses);
		const warnings = await saveImages(userId, { logId: log.id }, form, 'logimg_');
		return { logAdded: true, warning: warnings[0] ?? null };
	},

	deleteLog: async ({ request, locals }) => {
		const logId = Number((await request.formData()).get('logId'));
		await deleteLog(locals.user!.id, logId);
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
