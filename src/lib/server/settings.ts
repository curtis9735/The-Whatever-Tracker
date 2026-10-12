import { eq, inArray } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { APP_VERSION } from './config';
import { db, schema } from './db';

/** Credentials an admin can set in the UI. The env var of the same name is the fallback. */
export const CREDENTIALS = {
	TMDB_API_KEY: { provider: 'tmdb', label: 'API key or read access token', secret: true },
	IGDB_CLIENT_ID: { provider: 'igdb', label: 'Client ID', secret: false },
	IGDB_CLIENT_SECRET: { provider: 'igdb', label: 'Client secret', secret: true },
	BGG_API_TOKEN: { provider: 'bgg', label: 'Application token', secret: true },
	SETLISTFM_API_KEY: { provider: 'setlistfm', label: 'API key', secret: true },
	MUSICBRAINZ_CONTACT: { provider: 'musicbrainz', label: 'Contact email or URL', secret: false }
} as const;

export type CredentialKey = keyof typeof CREDENTIALS;
export type CredentialSource = 'app' | 'stack' | null;

export function isCredentialKey(k: string): k is CredentialKey {
	return k in CREDENTIALS;
}

export function credentialKeysFor(provider: string): CredentialKey[] {
	return (Object.keys(CREDENTIALS) as CredentialKey[]).filter((k) => CREDENTIALS[k].provider === provider);
}

// Settings are read on every provider call, so keep them in memory; writes go through saveCredentials.
let cache: Map<string, string> | null = null;

function saved() {
	if (!cache) {
		cache = new Map(
			db()
				.select({ key: schema.appSettings.key, value: schema.appSettings.value })
				.from(schema.appSettings)
				.all()
				.map((r) => [r.key, r.value])
		);
	}
	return cache;
}

/** Effective value: saved in the app first, then the stack's environment variable. */
export function credential(key: CredentialKey): string {
	return saved().get(key) ?? (env[key] ?? '').trim();
}

export function credentialSource(key: CredentialKey): CredentialSource {
	if (saved().has(key)) return 'app';
	return (env[key] ?? '').trim() ? 'stack' : null;
}

/** Sets (string) or removes (null) saved values; returns the previous saved values for rollback. */
export function saveCredentials(
	changes: Partial<Record<CredentialKey, string | null>>,
	userId: number | null
) {
	const previous: Partial<Record<CredentialKey, string | null>> = {};
	db().transaction(() => {
		for (const [key, value] of Object.entries(changes) as [CredentialKey, string | null][]) {
			previous[key] = saved().get(key) ?? null;
			if (value === null) {
				db().delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
			} else {
				db()
					.insert(schema.appSettings)
					.values({ key, value, updatedAt: new Date(), updatedBy: userId })
					.onConflictDoUpdate({
						target: schema.appSettings.key,
						set: { value, updatedAt: new Date(), updatedBy: userId }
					})
					.run();
			}
		}
	});
	cache = null;
	return previous;
}

export function savedUpdatedAt(keys: CredentialKey[]) {
	if (!keys.length) return null;
	const rows = db()
		.select({ updatedAt: schema.appSettings.updatedAt })
		.from(schema.appSettings)
		.where(inArray(schema.appSettings.key, keys))
		.all();
	const times = rows.map((r) => r.updatedAt.getTime());
	return times.length ? new Date(Math.max(...times)) : null;
}

/** Shows just enough of a secret to recognize it. */
export function maskSecret(value: string) {
	if (!value) return '';
	if (value.length <= 8) return '••••';
	return `••••${value.slice(-4)}`;
}

/** Effective provider credentials (read at call time so UI changes apply immediately). */
export function keys() {
	return {
		tmdbKey: credential('TMDB_API_KEY'),
		igdbClientId: credential('IGDB_CLIENT_ID'),
		igdbClientSecret: credential('IGDB_CLIENT_SECRET'),
		bggToken: credential('BGG_API_TOKEN'),
		setlistfmKey: credential('SETLISTFM_API_KEY'),
		musicbrainzContact: credential('MUSICBRAINZ_CONTACT')
	};
}

export function userAgent() {
	const contact = credential('MUSICBRAINZ_CONTACT') || 'https://github.com/curtis9735/The-Whatever-Tracker';
	return `WhateverTracker/${APP_VERSION} ( ${contact} )`;
}
