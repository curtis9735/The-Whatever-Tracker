import { getProvider } from './providers/registry';
import { testSetlistfm, setlistfmEnabled } from './providers/setlistfm';
import { ProviderError, type ProviderErrorCode } from './providers/util';
import {
	CREDENTIALS,
	credential,
	credentialKeysFor,
	credentialSource,
	maskSecret,
	savedUpdatedAt
} from './settings';

interface Integration {
	id: string;
	label: string;
	gives: string;
	howTo: string;
	docsUrl: string;
	enabled: () => boolean;
	test?: (signal?: AbortSignal) => Promise<void>;
}

function fromProvider(id: string, gives: string, howTo: string): Integration {
	const p = getProvider(id)!;
	return {
		id,
		label: p.label,
		gives,
		howTo,
		docsUrl: p.docsUrl,
		enabled: () => p.enabled(),
		test: (signal) => p.test(signal)
	};
}

export const INTEGRATIONS: Integration[] = [
	fromProvider(
		'tmdb',
		'Movies and TV shows',
		'Free TMDB account → Settings → API. Either the API key or the API read access token works.'
	),
	fromProvider(
		'igdb',
		'Video games',
		'Twitch developer console → Register your application (category “Application Integration”, any redirect URL such as http://localhost) → copy the client ID, then create a new secret.'
	),
	fromProvider(
		'bgg',
		'Board games',
		'Register an application on BoardGameGeek, wait for approval (BGG says it can take a week or more), then create a token for it.'
	),
	fromProvider(
		'musicbrainz',
		'Artists and albums, with cover art',
		'No key needed. MusicBrainz asks every app to identify itself with contact info: an email address or a URL.'
	),
	fromProvider(
		'lastfm',
		'Album and artist details, and your listening history',
		'Create an API account at last.fm/api/account/create (any name and description, no callback URL needed). Copy the API key; the shared secret isn’t used.'
	),
	{
		id: 'setlistfm',
		label: 'setlist.fm',
		gives: 'Concert setlists when you log a show',
		howTo:
			'Free setlist.fm account → Settings → API → apply for a key (non-commercial use). Then make sure “Concert setlists” is ticked in your concerts list’s settings (it is for the Concerts template).',
		docsUrl: 'https://www.setlist.fm/settings/api',
		enabled: setlistfmEnabled,
		test: testSetlistfm
	},
	{
		id: 'openfoodfacts',
		label: 'Open Food Facts',
		gives: 'Barcode lookups',
		howTo: 'Always on, no key needed.',
		docsUrl: 'https://world.openfoodfacts.org/',
		enabled: () => true
	}
];

export function getIntegration(id: string) {
	return INTEGRATIONS.find((i) => i.id === id) ?? null;
}

/** What the settings page shows. Current values (masked if secret) are only included for admins. */
export function integrationsView(isAdmin: boolean) {
	return INTEGRATIONS.map((i) => {
		const keys = credentialKeysFor(i.id);
		return {
			id: i.id,
			label: i.label,
			gives: i.gives,
			howTo: i.howTo,
			docsUrl: i.docsUrl,
			enabled: i.enabled(),
			testable: !!i.test,
			updatedAt: isAdmin ? (savedUpdatedAt(keys)?.toISOString() ?? null) : null,
			fields: keys.map((key) => {
				const value = credential(key);
				const def = CREDENTIALS[key];
				return {
					key,
					label: def.label,
					secret: def.secret,
					source: credentialSource(key),
					current: isAdmin && value ? (def.secret ? maskSecret(value) : value) : null
				};
			})
		};
	});
}

export type TestResult = { ok: true } | { ok: false; code: ProviderErrorCode | 'timeout'; message: string };

export async function runIntegrationTest(id: string): Promise<TestResult> {
	const integration = getIntegration(id);
	if (!integration?.test) return { ok: false, code: 'other', message: 'Nothing to test for this source.' };
	if (!integration.enabled()) {
		return { ok: false, code: 'other', message: `${integration.label} has no credentials yet.` };
	}
	try {
		// BGG spaces requests 2 s apart, so allow a little longer than a normal search
		await integration.test(AbortSignal.timeout(25_000));
		return { ok: true };
	} catch (e) {
		if (e instanceof ProviderError) return { ok: false, code: e.code, message: e.message };
		const name = (e as Error).name;
		if (name === 'TimeoutError' || name === 'AbortError') {
			return { ok: false, code: 'timeout', message: `${integration.label} took too long to answer.` };
		}
		return { ok: false, code: 'other', message: (e as Error).message || 'The test failed.' };
	}
}
