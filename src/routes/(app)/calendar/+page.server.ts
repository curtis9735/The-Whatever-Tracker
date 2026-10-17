import { fail } from '@sveltejs/kit';
import { todayIso } from '$lib/server/forms';
import {
	calendarLists,
	refreshReleases,
	releasesBetween,
	releasesCheckedAt,
	releaseSourcesReady,
	setListInCalendar
} from '$lib/server/services/releases';
import { monthGrid, parseMonth } from '$lib/calendar';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.user!.id;
	const today = todayIso();
	const month = parseMonth(url.searchParams.get('month'), today);
	const grid = monthGrid(month);
	const checkedAt = releasesCheckedAt(userId);
	return {
		today,
		month,
		grid,
		view: url.searchParams.get('view') === 'list' ? ('list' as const) : ('grid' as const),
		events: releasesBetween(userId, grid.start, grid.end),
		lists: calendarLists(userId),
		ready: releaseSourcesReady(),
		checkedAt: checkedAt ? checkedAt.toISOString() : null
	};
};

export const actions: Actions = {
	/** "Fetch new releases" */
	refresh: async ({ locals }) => {
		if (!releaseSourcesReady()) {
			return fail(400, { message: 'Connect TMDB (or IGDB for games) under Me → Integrations first.' });
		}
		const result = await refreshReleases(locals.user!.id);
		return { refreshed: result };
	},

	/** Shows or hides one list's releases (just for this person, on a list shared with them) */
	toggleList: async ({ locals, request }) => {
		const form = await request.formData();
		const id = Number(form.get('categoryId'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { message: 'Unknown list' });
		setListInCalendar(locals.user!.id, id, form.get('shown') === 'true');
		return { toggled: id };
	}
};
