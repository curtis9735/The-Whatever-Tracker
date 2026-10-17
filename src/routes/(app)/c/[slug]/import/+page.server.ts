import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { getCategoryBySlug } from '$lib/server/services/categories';
import { ImportError } from '$lib/server/import/yamtrack';
import { applySheetImport, listContext, MAX_SHEET_TEXT } from '$lib/server/import/sheet';
import type { Actions, PageServerLoad } from './$types';

const Mapping = z.object({
	targets: z.array(z.string().max(80)).max(200),
	statusMap: z.record(z.string().max(200), z.string().max(80)),
	ratingMax: z.number().positive().max(1000).nullable(),
	ratingNotes: z.boolean()
});
const Skipped = z.array(z.number().int().min(0)).max(10_000);

export const load: PageServerLoad = async ({ locals, params }) => {
	// Importing is for the list's owner: it adds fields and choices to the list
	const { category } = getCategoryBySlug(locals.user!.id, params.slug, 'owner');
	return {
		category: { id: category.id, name: category.name, slug: category.slug, icon: category.icon },
		ctx: listContext(locals.user!.id, category.id)
	};
};

export const actions: Actions = {
	import: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const { category } = getCategoryBySlug(userId, params.slug, 'owner');
		const form = await request.formData();
		const text = String(form.get('text') ?? '');
		if (!text.trim()) return fail(400, { message: 'There is nothing to import. Paste your table first.' });
		if (text.length > MAX_SHEET_TEXT) return fail(400, { message: 'That is too much data for one import.' });

		let mapping: z.infer<typeof Mapping>;
		let skipped: number[];
		try {
			mapping = Mapping.parse(JSON.parse(String(form.get('mapping') ?? '')));
			skipped = Skipped.parse(JSON.parse(String(form.get('skipped') ?? '[]')));
		} catch {
			return fail(400, { message: 'The column choices could not be read. Reload the page and try again.' });
		}

		try {
			return { done: applySheetImport(userId, category.id, text, mapping, skipped) };
		} catch (e) {
			if (e instanceof ImportError) return fail(400, { message: e.message });
			throw e;
		}
	}
};
