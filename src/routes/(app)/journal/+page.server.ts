import { todayIso } from '$lib/server/forms';
import { listCategories } from '$lib/server/services/categories';
import { hasListeningLogs, isListeningMode, journal, logBounds } from '$lib/server/services/journal';
import { getLastfmAccount } from '$lib/server/services/lastfm-sync';
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
	// How imported listening shows: ?listening=, else what the person chose on last.fm's settings, else every album
	const asked = sp.get('listening');
	// With no account (after "Stop syncing") the imported rows are still there: grouped, not thousands of albums
	const listening = isListeningMode(asked)
		? asked
		: (getLastfmAccount(userId)?.journalMode ?? (hasListeningLogs(userId) ? 'group' : 'all'));
	const limit = Math.min(Math.max(Number(sp.get('limit')) || PAGE, PAGE), 5000);
	return {
		range,
		today,
		list: list ? { slug: list.slug, name: list.name, icon: list.icon } : null,
		limit,
		listening,
		...journal(userId, range, today, list?.id ?? null, limit, listening)
	};
};
