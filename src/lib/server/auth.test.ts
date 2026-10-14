import { describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-auth-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const {
	FailureCounter,
	hashPassword,
	isTrustedDevice,
	rememberDevice,
	safeRedirectTarget,
	verifyPasswordOrDummy
} = await import('./auth');

const ORIGIN = 'https://tracker.example.com';

/** Just enough of SvelteKit's cookie jar for the device cookie. */
function jar(): Cookies {
	const store = new Map<string, string>();
	return {
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => void store.set(name, value)
	} as unknown as Cookies;
}

describe('redirect after signing in', () => {
	it('keeps pages of this app', () => {
		expect(safeRedirectTarget('/items/12?log=2026-10-10#history', ORIGIN)).toBe(
			'/items/12?log=2026-10-10#history'
		);
		expect(safeRedirectTarget('/', ORIGIN)).toBe('/');
		expect(safeRedirectTarget(null, ORIGIN)).toBe('/');
	});

	it('never sends you to another site, however the link is disguised', () => {
		for (const evil of [
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'/\t/evil.example',
			'/\n/evil.example',
			'javascript:alert(1)',
			'data:text/html,hi',
			'http://tracker.example.com/' // same host, but not over https
		]) {
			expect(safeRedirectTarget(evil, ORIGIN), evil).toBe('/');
		}
	});
});

describe('failure counters', () => {
	it('allow up to the limit, then block until the window passes', () => {
		const c = new FailureCounter(3, 1000);
		const t = 1_000_000;
		for (let i = 0; i < 3; i++) {
			expect(c.allowed('k', t)).toBe(true);
			c.fail('k', t);
		}
		expect(c.allowed('k', t)).toBe(false);
		expect(c.allowed('other', t)).toBe(true);
		expect(c.allowed('k', t + 1001)).toBe(true);
	});

	it('are cleared by a success', () => {
		const c = new FailureCounter(1);
		c.fail('k');
		expect(c.allowed('k')).toBe(false);
		c.clear('k');
		expect(c.allowed('k')).toBe(true);
	});
});

describe('trusted devices', () => {
	it('recognise a browser that signed in to that account, and only that account', () => {
		const cookies = jar();
		expect(isTrustedDevice(cookies, 'daniel')).toBe(false);
		rememberDevice(cookies, 'daniel', true);
		expect(isTrustedDevice(cookies, 'daniel')).toBe(true);
		expect(isTrustedDevice(cookies, 'someone-else')).toBe(false);
		expect(isTrustedDevice(cookies, '')).toBe(false);
	});

	it('cannot be forged', () => {
		const cookies = jar();
		cookies.set('wt_device', 'made-up-value', { path: '/' });
		expect(isTrustedDevice(cookies, 'daniel')).toBe(false);
	});
});

describe('password checks', () => {
	it('an unknown user is checked against a throwaway hash and always fails', async () => {
		expect(await verifyPasswordOrDummy(null, 'anything')).toBe(false);
		const real = await hashPassword('correct horse');
		expect(await verifyPasswordOrDummy(real, 'correct horse')).toBe(true);
		expect(await verifyPasswordOrDummy(real, 'wrong')).toBe(false);
	});
});
