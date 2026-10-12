import { redirect } from '@sveltejs/kit';
import { listCategories } from '$lib/server/services/categories';
import { enabledKinds } from '$lib/server/providers/registry';
import { setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { KINDS } from '$lib/kinds';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	if (!user.onboarded && url.pathname !== '/onboarding') redirect(303, '/onboarding');

	const categories = listCategories(user.id);
	const enabled = enabledKinds();
	// Search only the sources the user actually has a list for
	const searchKinds = KINDS.filter(
		(k) => enabled.has(k.key) && categories.some((c) => c.providerKinds.includes(k.key))
	).map((k) => k.key);

	return { user, categories, searchKinds, setlistReady: setlistfmEnabled() };
};
