import { fail, redirect } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db';
import {
	addressFailures,
	checkSetupCode,
	clientAddress,
	clearSetupCode,
	createSession,
	generateSessionToken,
	hashPassword,
	normalizeUsername,
	rememberDevice,
	setSessionCookie,
	userCount,
	validatePassword,
	validateUsername
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	if (userCount() > 0) redirect(303, '/login');
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		if (userCount() > 0) redirect(303, '/login');
		const form = await request.formData();
		const code = String(form.get('code') ?? '');
		const username = normalizeUsername(String(form.get('username') ?? ''));
		const displayName = String(form.get('displayName') ?? '').trim() || username;
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		const keep = { username, displayName };
		const throttleKey = `setup|${clientAddress(getClientAddress)}`;

		if (!addressFailures.allowed(throttleKey)) {
			return fail(429, { ...keep, message: 'Too many attempts. Wait 15 minutes and try again.' });
		}
		if (!checkSetupCode(code)) {
			addressFailures.fail(throttleKey);
			return fail(400, {
				...keep,
				message: 'That setup code is not right. Find it in the container logs (Portainer → container → Logs).'
			});
		}
		const err =
			validateUsername(username) ??
			validatePassword(password) ??
			(password !== confirm ? 'The passwords do not match.' : null);
		if (err) return fail(400, { ...keep, message: err });

		const user = db()
			.insert(schema.users)
			.values({ username, displayName, passwordHash: await hashPassword(password), isAdmin: true })
			.returning()
			.get();
		clearSetupCode();
		const token = generateSessionToken();
		const session = createSession(token, user.id);
		setSessionCookie(cookies, token, session.expiresAt, url.protocol === 'https:');
		rememberDevice(cookies, username, url.protocol === 'https:');
		redirect(303, '/onboarding');
	}
};
