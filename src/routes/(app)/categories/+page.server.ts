import { moveCategory } from '$lib/server/services/categories';
import type { Actions } from './$types';

export const actions: Actions = {
	move: async ({ request, locals }) => {
		const form = await request.formData();
		const dir = form.get('dir') === 'up' ? -1 : 1;
		moveCategory(locals.user!.id, Number(form.get('id')), dir);
	}
};
