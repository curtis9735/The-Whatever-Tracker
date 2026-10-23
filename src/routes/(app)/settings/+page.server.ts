import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import {
	createSession,
	generateSessionToken,
	hashPassword,
	invalidateUserSessions,
	passwordCheckFailures,
	setSessionCookie,
	validatePassword,
	verifyPassword
} from '$lib/server/auth';
import { getIntegration, integrationsView, runIntegrationTest } from '$lib/server/integrations';
import {
	credentialKeysFor,
	credentialSource,
	keys as providerKeys,
	saveCredentials,
	type CredentialKey
} from '$lib/server/settings';
import { getLastfmAccount, kickLastfm, resetLastfmAuthErrors } from '$lib/server/services/lastfm-sync';
import { listBackups } from '$lib/server/backup';
import { APP_VERSION, cfg } from '$lib/server/config';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const isAdmin = locals.user!.isAdmin;
	return {
		integrations: integrationsView(isAdmin),
		version: APP_VERSION,
		backups: isAdmin ? listBackups().map((b) => ({ ...b, modified: b.modified.toISOString() })) : [],
		dataDir: isAdmin ? cfg().dataDir : null,
		// The "Your last.fm" card: the person's own connection only
		lastfm: { ready: !!providerKeys().lastfmKey, account: getLastfmAccount(locals.user!.id) }
	};
};

function adminIntegration(locals: App.Locals, id: string) {
	if (!locals.user?.isAdmin) error(403, 'Only admins can change API keys');
	const integration = getIntegration(id);
	const keys = credentialKeysFor(id);
	if (!integration || !keys.length) error(404, 'Unknown integration');
	return { integration, keys };
}

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
		// Limited, so someone holding a stolen session can't guess the password to take the account over
		const key = String(user.id);
		if (!passwordCheckFailures.allowed(key)) {
			return fail(429, { passwordMessage: 'Too many attempts. Wait 15 minutes and try again.' });
		}
		if (!(await verifyPassword(user.passwordHash, current))) {
			passwordCheckFailures.fail(key);
			return fail(400, { passwordMessage: 'Your current password is not right.' });
		}
		passwordCheckFailures.clear(key);
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
	},

	/** Saves the fields that were filled in, then tests them; a key the source rejects is rolled back. */
	saveIntegration: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('integration') ?? '');
		const { integration, keys } = adminIntegration(locals, id);

		const changes: Partial<Record<CredentialKey, string>> = {};
		for (const key of keys) {
			const value = String(form.get(key) ?? '').trim();
			if (!value) continue; // blank = keep the current value
			if (value.length > 500 || /\s/.test(value)) {
				return fail(400, {
					integration: id,
					error: 'That does not look like a valid key (no spaces allowed).'
				});
			}
			changes[key] = value;
		}
		if (
			changes.MUSICBRAINZ_CONTACT &&
			!/^(https?:\/\/\S+|[^@\s]+@[^@\s]+\.[^@\s]+)$/.test(changes.MUSICBRAINZ_CONTACT)
		) {
			return fail(400, { integration: id, error: 'Enter an email address or a URL starting with https://.' });
		}
		if (changes.LASTFM_API_KEY && !/^[0-9a-f]{32}$/i.test(changes.LASTFM_API_KEY)) {
			return fail(400, { integration: id, error: 'A last.fm API key is 32 letters and digits.' });
		}
		if (!Object.keys(changes).length) {
			return fail(400, { integration: id, error: 'Type a new value to save.' });
		}

		const previous = saveCredentials(changes, locals.user!.id);
		if (!integration.enabled()) {
			return { integration: id, success: 'Saved. Fill in the remaining field to switch it on.' };
		}
		const result = await runIntegrationTest(id);
		if (result.ok) {
			// A new last.fm key un-pauses accounts the old one stopped, and syncing resumes right away
			if (changes.LASTFM_API_KEY) {
				resetLastfmAuthErrors();
				kickLastfm();
			}
			return { integration: id, success: 'Saved. The connection works.' };
		}
		if (result.code === 'auth') {
			saveCredentials(previous, locals.user!.id);
			return fail(400, { integration: id, error: `${result.message}. Nothing was saved.` });
		}
		return { integration: id, warning: `Saved, but the connection test didn't finish: ${result.message}` };
	},

	testIntegration: async ({ request, locals }) => {
		const id = String((await request.formData()).get('integration') ?? '');
		adminIntegration(locals, id);
		const result = await runIntegrationTest(id);
		return result.ok
			? { integration: id, success: 'The connection works.' }
			: fail(400, { integration: id, error: result.message });
	},

	/** Forgets the values saved in the app; the stack's environment variables apply again. */
	clearIntegration: async ({ request, locals }) => {
		const id = String((await request.formData()).get('integration') ?? '');
		const { integration, keys } = adminIntegration(locals, id);
		saveCredentials(Object.fromEntries(keys.map((k) => [k, null])), locals.user!.id);
		const fallback = keys.some((k) => credentialSource(k) === 'stack');
		return {
			integration: id,
			success: fallback
				? 'Removed. Using the value from the Portainer stack again.'
				: `Removed. ${integration.label} is now switched off.`
		};
	}
};
