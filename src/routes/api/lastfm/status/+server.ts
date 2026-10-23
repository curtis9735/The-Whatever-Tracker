import { json } from '@sveltejs/kit';
import { getLastfmAccount } from '$lib/server/services/lastfm-sync';
import type { RequestHandler } from './$types';

/** The signed-in person's own last.fm import status, for the settings page to poll */
export const GET: RequestHandler = async ({ locals }) => {
	const account = getLastfmAccount(locals.user!.id);
	return json(account ? { connected: true, ...account } : { connected: false }, {
		headers: { 'Cache-Control': 'no-store' }
	});
};
