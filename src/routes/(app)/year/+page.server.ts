import { redirect } from '@sveltejs/kit';
import { todayIso } from '$lib/server/forms';
import { reviewYears } from '$lib/server/services/year';
import type { PageServerLoad } from './$types';

/** The newest year with anything in it, or this year (empty, but friendly) */
export const load: PageServerLoad = ({ locals }) => {
	const today = todayIso();
	redirect(302, `/year/${reviewYears(locals.user!.id, today)[0] ?? today.slice(0, 4)}`);
};
