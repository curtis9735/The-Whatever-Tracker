import { fail, redirect } from '@sveltejs/kit';
import { createCategory, createCategoryFromTemplate } from '$lib/server/services/categories';
import { DEFAULT_STATUSES, TEMPLATES, TEMPLATE_BY_KEY } from '$lib/server/templates';
import { CATEGORY_COLORS } from '$lib/kinds';
import { cleanIcon } from '$lib/icons';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	templates: TEMPLATES.map((t) => ({ key: t.key, name: t.name, icon: t.icon, description: t.description }))
});

export const actions: Actions = {
	template: async ({ request, locals }) => {
		const key = String((await request.formData()).get('template') ?? '');
		if (!TEMPLATE_BY_KEY.has(key)) return fail(400, { message: 'Unknown template' });
		const cat = createCategoryFromTemplate(locals.user!.id, key);
		redirect(303, `/c/${cat.slug}`);
	},
	blank: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 60);
		const icon = cleanIcon(form.get('icon'));
		if (!name) return fail(400, { message: 'Give the list a name.' });
		const color =
			Object.keys(CATEGORY_COLORS)[Math.floor(Math.random() * Object.keys(CATEGORY_COLORS).length)];
		const cat = createCategory(locals.user!.id, {
			name,
			icon,
			color,
			statuses: DEFAULT_STATUSES,
			providerKinds: []
		});
		redirect(303, `/categories/${cat.slug}/edit?new=1`);
	}
};
