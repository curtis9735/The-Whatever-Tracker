import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import {
	clientAddress,
	clearFailedLogins,
	createSession,
	generateSessionToken,
	loginAllowed,
	normalizeUsername,
	recordFailedLogin,
	setSessionCookie,
	userCount,
	verifyPassword
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function safeNext(next: string | null) {
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (userCount() === 0) redirect(303, '/setup');
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const form = await request.formData();
		const username = normalizeUsername(String(form.get('username') ?? ''));
		const password = String(form.get('password') ?? '');
		const throttleKey = `${clientAddress(getClientAddress)}|${username}`;

		if (!loginAllowed(throttleKey)) {
			return fail(429, { username, message: 'Too many attempts. Wait 15 minutes and try again.' });
		}
		const user = db().select().from(schema.users).where(eq(schema.users.username, username)).get();
		const ok = user ? await verifyPassword(user.passwordHash, password) : false;
		if (!user || !ok) {
			recordFailedLogin(throttleKey);
			return fail(400, { username, message: 'Wrong username or password.' });
		}
		clearFailedLogins(throttleKey);
		const token = generateSessionToken();
		const session = createSession(token, user.id);
		setSessionCookie(cookies, token, session.expiresAt, url.protocol === 'https:');
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
