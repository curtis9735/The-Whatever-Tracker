import { todayIso } from '$lib/server/forms';
import { listCategories } from '$lib/server/services/categories';
import { journal, logBounds } from '$lib/server/services/journal';
import { resolveRange } from '$lib/journal';
import type { PageServerLoad } from './$types';

const PAGE = 120;

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.user!.id;
	const sp = url.searchParams;
	// ?list=<slug> narrows everything to one list (slug@owner for a list shared with you)
	const list = listCategories(userId).find((c) => c.slug === sp.get('list')) ?? null;
	const today = todayIso();
	const range = resolveRange(
		{ range: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
		today,
		sp.get('range') === 'all-time' ? logBounds(userId, list?.id ?? null) : undefined
	);
	const limit = Math.min(Math.max(Number(sp.get('limit')) || PAGE, PAGE), 5000);
	return {
		range,
		today,
		list: list ? { slug: list.slug, name: list.name, icon: list.icon } : null,
		limit,
		...journal(userId, range, today, list?.id ?? null, limit)
	};
};
