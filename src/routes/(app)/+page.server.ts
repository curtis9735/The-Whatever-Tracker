import { itemStrip, recentActivity } from '$lib/server/services/items';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	return {
		activity: recentActivity(userId, 15),
		upNext: itemStrip(userId, 'planned', 12),
		favorites: itemStrip(userId, 'favorites', 12)
	};
};
