import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import {
	createSession,
	generateSessionToken,
	hashPassword,
	invalidateUserSessions,
	setSessionCookie,
	validatePassword,
	verifyPassword
} from '$lib/server/auth';
import { PROVIDERS } from '$lib/server/providers/registry';
import { setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { listBackups } from '$lib/server/backup';
import { APP_VERSION, cfg } from '$lib/server/config';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const integrations = [
		...PROVIDERS.map((p) => ({
			id: p.id,
			label: p.label,
			env: p.env,
			docsUrl: p.docsUrl,
			enabled: p.enabled()
		})),
		{
			id: 'setlistfm',
			label: 'setlist.fm',
			env: ['SETLISTFM_API_KEY'],
			docsUrl: 'https://www.setlist.fm/settings/api',
			enabled: setlistfmEnabled()
		},
		{
			id: 'openfoodfacts',
			label: 'Open Food Facts (barcodes)',
			env: [],
			docsUrl: 'https://world.openfoodfacts.org/',
			enabled: true
		}
	];
	return {
		integrations,
		version: APP_VERSION,
		backups: locals.user!.isAdmin
			? listBackups().map((b) => ({ ...b, modified: b.modified.toISOString() }))
			: [],
		dataDir: locals.user!.isAdmin ? cfg().dataDir : null
	};
};

export const actions: Actions = {
	profile: async ({ request, locals }) => {
		const displayName = String((await request.formData()).get('displayName') ?? '')
			.trim()
			.slice(0, 60);
		if (!displayName) return fail(400, { profileMessage: 'Display name cannot be empty.' });
		db().update(schema.users).set({ displayName }).where(eq(schema.users.id, locals.user!.id)).run();
		return { profileSaved: true };
	},
	password: async ({ request, locals, cookies, url }) => {
		const form = await request.formData();
		const current = String(form.get('current') ?? '');
		const next = String(form.get('next') ?? '');
		const user = db().select().from(schema.users).where(eq(schema.users.id, locals.user!.id)).get()!;
		if (!(await verifyPassword(user.passwordHash, current))) {
			return fail(400, { passwordMessage: 'Your current password is not right.' });
		}
		const err = validatePassword(next);
		if (err) return fail(400, { passwordMessage: err });
		db()
			.update(schema.users)
			.set({ passwordHash: await hashPassword(next) })
			.where(eq(schema.users.id, user.id))
			.run();
		// Sign out everywhere else, keep this device signed in
		invalidateUserSessions(user.id);
		const token = generateSessionToken();
		const session = createSession(token, user.id);
		setSessionCookie(cookies, token, session.expiresAt, url.protocol === 'https:');
		return { passwordSaved: true };
	}
};
