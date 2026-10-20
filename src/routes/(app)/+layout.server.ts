import { redirect } from '@sveltejs/kit';
import { listCategories } from '$lib/server/services/categories';
import { enabledKinds } from '$lib/server/providers/registry';
import { setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { currentWatching, settleMine } from '$lib/server/services/watching';
import { KINDS } from '$lib/kinds';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	if (!user.onboarded && url.pathname !== '/onboarding') redirect(303, '/onboarding');

	// Their own lists, then the ones others share with them
	const categories = listCategories(user.id);
	const enabled = enabledKinds();
	// Search only the sources the user has a list to add to (their own, or one shared with them to edit)
	const addable = categories.filter((c) => c.access !== 'view');
	const searchKinds = KINDS.filter(
		(k) => enabled.has(k.key) && addable.some((c) => c.providerKinds.includes(k.key))
	).map((k) => k.key);

	// A check-in whose time is up is marked watched before the page shows it
	await settleMine(user.id);
	const watching = currentWatching(user.id);

	return { user, categories, searchKinds, setlistReady: setlistfmEnabled(), watching };
};
