import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import {
	accountFailures,
	addressFailures,
	clientAddress,
	createSession,
	generateSessionToken,
	isTrustedDevice,
	normalizeUsername,
	rememberDevice,
	safeRedirectTarget,
	setSessionCookie,
	userCount,
	verifyPasswordOrDummy
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (userCount() === 0) redirect(303, '/setup');
	if (locals.user) redirect(303, safeRedirectTarget(url.searchParams.get('next'), url.origin));
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const form = await request.formData();
		const username = normalizeUsername(String(form.get('username') ?? '')).slice(0, 64);
		const password = String(form.get('password') ?? '').slice(0, 256);
		const address = clientAddress(getClientAddress);
		const trusted = isTrustedDevice(cookies, username);

		if (!addressFailures.allowed(address) || (!trusted && !accountFailures.allowed(username))) {
			return fail(429, { username, message: 'Too many attempts. Wait 15 minutes and try again.' });
		}
		const user = db().select().from(schema.users).where(eq(schema.users.username, username)).get();
		// Always runs a full password check, so a wrong username answers as slowly as a wrong password
		const ok = await verifyPasswordOrDummy(user?.passwordHash ?? null, password);
		if (!user || !ok) {
			addressFailures.fail(address);
			accountFailures.fail(username);
			return fail(400, { username, message: 'Wrong username or password.' });
		}
		accountFailures.clear(username);
		const secure = url.protocol === 'https:';
		const token = generateSessionToken();
		const session = createSession(token, user.id);
		setSessionCookie(cookies, token, session.expiresAt, secure);
		rememberDevice(cookies, username, secure);
		redirect(303, safeRedirectTarget(url.searchParams.get('next'), url.origin));
	}
};
