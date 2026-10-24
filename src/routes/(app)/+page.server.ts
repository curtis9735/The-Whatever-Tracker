import { addDays } from '$lib/journal';
import { todayIso } from '$lib/server/forms';
import { itemStrip, recentActivity } from '$lib/server/services/items';
import { releasesBetween } from '$lib/server/services/releases';
import { reviewYears } from '$lib/server/services/year';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	const today = todayIso();
	// December and January: the year just ending (or just ended), when there is something in it
	const month = Number(today.slice(5, 7));
	const reviewYear =
		month === 12 ? Number(today.slice(0, 4)) : month === 1 ? Number(today.slice(0, 4)) - 1 : null;
	return {
		today,
		reviewYear: reviewYear !== null && reviewYears(userId, today).includes(reviewYear) ? reviewYear : null,
		activity: recentActivity(userId, 15),
		upNext: itemStrip(userId, 'planned', 12),
		favorites: itemStrip(userId, 'favorites', 12),
		// The coming week of episodes, movies and games (from lists shown in the Calendar)
		comingUp: releasesBetween(userId, today, addDays(today, 7), 24)
	};
};
