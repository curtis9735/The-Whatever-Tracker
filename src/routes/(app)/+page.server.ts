import { addDays } from '$lib/journal';
import { todayIso } from '$lib/server/forms';
import { itemStrip, recentActivity } from '$lib/server/services/items';
import { releasesBetween } from '$lib/server/services/releases';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	const today = todayIso();
	return {
		today,
		activity: recentActivity(userId, 15),
		upNext: itemStrip(userId, 'planned', 12),
		favorites: itemStrip(userId, 'favorites', 12),
		// The coming week of episodes, movies and games (from lists shown in the Calendar)
		comingUp: releasesBetween(userId, today, addDays(today, 7), 24)
	};
};
