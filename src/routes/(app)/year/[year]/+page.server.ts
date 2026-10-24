import { error } from '@sveltejs/kit';
import { todayIso } from '$lib/server/forms';
import { reviewYears, yearInReview } from '$lib/server/services/year';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	if (!/^\d{4}$/.test(params.year) || Number(params.year) < 1000) error(404, 'Year not found');
	const userId = locals.user!.id;
	const year = Number(params.year);
	const today = todayIso();
	// Years with activity, plus this one (it may be empty, and is the one being looked at)
	const years = [...new Set([...reviewYears(userId, today), year])].sort((a, b) => b - a);
	const review = yearInReview(userId, year, today);
	const at = years.indexOf(year);
	return {
		year,
		years,
		// The next year back / forward that has something (or is the one being looked at)
		older: years[at + 1] ?? null,
		newer: at > 0 ? years[at - 1] : null,
		review,
		empty: !review.headline.logged && !review.watching && !review.music
	};
};
