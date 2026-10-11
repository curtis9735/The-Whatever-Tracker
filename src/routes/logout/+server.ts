import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, invalidateSession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, cookies, url }) => {
	if (locals.sessionId) invalidateSession(locals.sessionId);
	clearSessionCookie(cookies, url.protocol === 'https:');
	redirect(303, '/login');
};
