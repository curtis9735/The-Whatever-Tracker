import { redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { createCategoryFromTemplate, listCategories } from '$lib/server/services/categories';
import { enabledKinds } from '$lib/server/providers/registry';
import { TEMPLATES, TEMPLATE_BY_KEY } from '$lib/server/templates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const enabled = enabledKinds();
	const existing = new Set(listCategories(locals.user!.id).map((c) => c.name.toLowerCase()));
	return {
		templates: TEMPLATES.map((t) => ({
			key: t.key,
			name: t.name,
			icon: t.icon,
			description: t.description,
			needsSource: t.providerKinds.length > 0,
			sourceReady: t.providerKinds.every((k) => enabled.has(k)),
			exists: existing.has(t.name.toLowerCase())
		}))
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const form = await request.formData();
		const userId = locals.user!.id;
		for (const key of form.getAll('templates').map(String)) {
			if (TEMPLATE_BY_KEY.has(key)) createCategoryFromTemplate(userId, key);
		}
		db().update(schema.users).set({ onboarded: true }).where(eq(schema.users.id, userId)).run();
		redirect(303, '/');
	}
};
