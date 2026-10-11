import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, fetchPublicImage, isPrivateAddress } from './ssrf';

describe('isPrivateAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.20',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'224.0.0.1',
		'::1',
		'fd00::1',
		'fe80::1',
		'::ffff:192.168.1.1',
		'not-an-ip'
	])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

	it.each(['8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700::6810:85e5'])('allows %s', (ip) =>
		expect(isPrivateAddress(ip)).toBe(false)
	);
});

describe('assertPublicUrl', () => {
	const lookup = (map: Record<string, string[]>) =>
		(async (host: string) => (map[host] ?? []).map((address) => ({ address, family: 4 }))) as never;

	it('rejects non-http schemes and credentials', async () => {
		await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
		await expect(assertPublicUrl('ftp://example.com/a.jpg')).rejects.toThrow(/http/);
		await expect(assertPublicUrl('https://user:pw@example.com/a.jpg')).rejects.toThrow(/credentials/);
	});

	it('rejects private literals and local names', async () => {
		await expect(assertPublicUrl('http://192.168.1.10/cam.jpg')).rejects.toThrow(/private/);
		await expect(assertPublicUrl('http://[::1]/x.png')).rejects.toThrow(/private/);
		await expect(assertPublicUrl('http://nas.local/x.png')).rejects.toThrow(/private/);
		await expect(assertPublicUrl('http://localhost:5000/x.png')).rejects.toThrow(/private/);
	});

	it('rejects hostnames that resolve to private addresses (DNS rebinding style)', async () => {
		const l = lookup({ 'evil.example': ['93.184.216.34', '10.0.0.5'] });
		await expect(assertPublicUrl('https://evil.example/a.jpg', l)).rejects.toThrow(/private/);
	});

	it('accepts public hosts', async () => {
		const l = lookup({ 'images.example': ['93.184.216.34'] });
		const url = await assertPublicUrl('https://images.example/a.jpg', l);
		expect(url.hostname).toBe('images.example');
	});
});

describe('fetchPublicImage', () => {
	afterEach(() => vi.unstubAllGlobals());
	const PUBLIC = 'http://93.184.216.34/photo.jpg';
	const opts = { userAgent: 'test', maxBytes: 1000 };

	it('re-checks every redirect hop', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin.png' } })
			)
		);
		await expect(fetchPublicImage(PUBLIC, opts)).rejects.toThrow(/private/);
	});

	it('enforces the declared size cap', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response('x', { headers: { 'content-type': 'image/jpeg', 'content-length': '5000' } })
			)
		);
		await expect(fetchPublicImage(PUBLIC, opts)).rejects.toThrow(/larger/);
	});

	it('enforces the size cap while streaming', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(new Uint8Array(4000), { headers: { 'content-type': 'image/jpeg' } }))
		);
		await expect(fetchPublicImage(PUBLIC, opts)).rejects.toThrow(/larger/);
	});

	it('refuses non-image responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
		);
		await expect(fetchPublicImage(PUBLIC, opts)).rejects.toThrow(/image/);
	});

	it('returns the bytes of a small image', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
		);
		expect([...(await fetchPublicImage(PUBLIC, opts))]).toEqual([1, 2, 3]);
	});
});
