import { afterEach, describe, expect, it, vi } from 'vitest';

// Throwaway data dir, plus keys "from the Portainer stack"
vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-settings-'));
	return {
		env: {
			DATA_DIR: dir,
			MIGRATIONS_DIR: path.resolve('drizzle'),
			TMDB_API_KEY: 'stack-tmdb-key-1234',
			IGDB_CLIENT_ID: 'stack-client'
		}
	};
});

const settings = await import('./settings');
const { integrationsView, runIntegrationTest } = await import('./integrations');

afterEach(() => vi.unstubAllGlobals());

describe('credential precedence', () => {
	it('falls back to the stack, lets the app override, and clearing restores the stack value', () => {
		expect(settings.credential('TMDB_API_KEY')).toBe('stack-tmdb-key-1234');
		expect(settings.credentialSource('TMDB_API_KEY')).toBe('stack');
		expect(settings.credentialSource('BGG_API_TOKEN')).toBeNull();

		settings.saveCredentials({ TMDB_API_KEY: 'app-key-abcdef9876' }, null);
		expect(settings.keys().tmdbKey).toBe('app-key-abcdef9876');
		expect(settings.credentialSource('TMDB_API_KEY')).toBe('app');

		settings.saveCredentials({ TMDB_API_KEY: null }, null);
		expect(settings.keys().tmdbKey).toBe('stack-tmdb-key-1234');
	});

	it('returns previous values so a rejected key can be rolled back', () => {
		settings.saveCredentials({ BGG_API_TOKEN: 'first-token-000' }, null);
		const previous = settings.saveCredentials({ BGG_API_TOKEN: 'second-token-111' }, null);
		expect(previous).toEqual({ BGG_API_TOKEN: 'first-token-000' });
		settings.saveCredentials(previous, null);
		expect(settings.credential('BGG_API_TOKEN')).toBe('first-token-000');
		settings.saveCredentials({ BGG_API_TOKEN: null }, null);
	});

	it('masks secrets', () => {
		expect(settings.maskSecret('abcdefghijkl1234')).toBe('••••1234');
		expect(settings.maskSecret('short')).toBe('••••');
		expect(settings.maskSecret('')).toBe('');
	});
});

describe('settings view', () => {
	it('shows masked values to admins only, and plain contact info', () => {
		settings.saveCredentials({ MUSICBRAINZ_CONTACT: 'me@example.com' }, null);
		const admin = integrationsView(true);
		const tmdb = admin.find((i) => i.id === 'tmdb')!;
		expect(tmdb.fields[0]).toMatchObject({ key: 'TMDB_API_KEY', source: 'stack', current: '••••1234' });
		expect(admin.find((i) => i.id === 'musicbrainz')!.fields[0].current).toBe('me@example.com');
		const igdb = admin.find((i) => i.id === 'igdb')!;
		expect(igdb.enabled).toBe(false); // client secret still missing

		const member = integrationsView(false);
		expect(member.flatMap((i) => i.fields).every((f) => f.current === null)).toBe(true);
		settings.saveCredentials({ MUSICBRAINZ_CONTACT: null }, null);
	});
});

describe('connection tests', () => {
	it('reports a rejected TMDB key as an auth failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 401 }))
		);
		expect(await runIntegrationTest('tmdb')).toMatchObject({ ok: false, code: 'auth' });
	});

	it('reports an unknown Twitch client ID (HTTP 400) as an auth failure', async () => {
		settings.saveCredentials({ IGDB_CLIENT_SECRET: 'some-secret-value' }, null);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"message":"invalid client"}', { status: 400 }))
		);
		expect(await runIntegrationTest('igdb')).toMatchObject({ ok: false, code: 'auth' });
		settings.saveCredentials({ IGDB_CLIENT_SECRET: null }, null);
	});

	it('does not call an outage an auth failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		expect(await runIntegrationTest('tmdb')).toMatchObject({ ok: false, code: 'unreachable' });
	});

	it('passes when the source answers', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"images":{}}', { status: 200 }))
		);
		expect(await runIntegrationTest('tmdb')).toEqual({ ok: true });
	});
});
