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
import { parseLogForm, todayIso } from '$lib/server/forms';
import { ImageError } from '$lib/server/images/store';
import type { Actions, PageServerLoad } from './$types';

function logId(params: { id: string }) {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Log not found');
	return id;
}

export const load: PageServerLoad = async ({ locals, params }) => {
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
	return { log, item, ...cat, images, today: todayIso() };
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
		updateLog(userId, log.id, parsed.data);
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
