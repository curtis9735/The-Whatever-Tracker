import dns from 'node:dns/promises';
import net from 'node:net';

/** True for addresses a server-side fetch must never reach (LAN, loopback, link-local, metadata...). */
export function isPrivateAddress(address: string): boolean {
	let ip = address;
	if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
	const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (v4mapped) ip = v4mapped[1];

	if (net.isIPv4(ip)) {
		const [a, b] = ip.split('.').map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) || // CGNAT
			(a === 169 && b === 254) || // link-local / cloud metadata
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224 // multicast + reserved
		);
	}
	if (net.isIPv6(ip)) {
		const lower = ip.toLowerCase();
		return (
			lower === '::' ||
			lower === '::1' ||
			lower.startsWith('fc') ||
			lower.startsWith('fd') || // unique local
			/^fe[89ab]/.test(lower) || // link-local
			lower.startsWith('ff') || // multicast
			lower.startsWith('::ffff:') || // other mapped forms
			lower.startsWith('64:ff9b:') // NAT64
		);
	}
	return true; // not an IP at all: refuse
}

export class UnsafeUrlError extends Error {}

/** Throws unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string, lookup = dns.lookup): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeUrlError('That is not a valid link.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new UnsafeUrlError('Only http:// and https:// links are supported.');
	}
	if (url.username || url.password) throw new UnsafeUrlError('Links with credentials are not allowed.');

	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (net.isIP(host)) {
		if (isPrivateAddress(host))
			throw new UnsafeUrlError('Links to private network addresses cannot be copied.');
		return url;
	}
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
		throw new UnsafeUrlError('Links to private network addresses cannot be copied.');
	}
	let addrs: { address: string }[];
	try {
		addrs = await lookup(host, { all: true });
	} catch {
		throw new UnsafeUrlError(`Could not resolve ${host}.`);
	}
	if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
		throw new UnsafeUrlError('Links to private network addresses cannot be copied.');
	}
	return url;
}

export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Downloads an image from a public URL: manual redirects (each hop re-checked),
 * a size cap and a timeout.
 */
export async function fetchPublicImage(
	raw: string,
	opts: { userAgent: string; maxBytes?: number; timeoutMs?: number; maxRedirects?: number }
): Promise<Buffer> {
	const maxBytes = opts.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
	let current = raw;
	for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
		const url = await assertPublicUrl(current);
		const res = await fetch(url, {
			redirect: 'manual',
			signal,
			headers: { 'User-Agent': opts.userAgent, Accept: 'image/*' }
		});
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			if (!loc) throw new UnsafeUrlError('The link redirected without a destination.');
			current = new URL(loc, url).toString();
			continue;
		}
		if (!res.ok) throw new UnsafeUrlError(`The image link returned HTTP ${res.status}.`);
		const type = res.headers.get('content-type') || '';
		if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
			throw new UnsafeUrlError('That link does not point to an image.');
		}
		const declared = Number(res.headers.get('content-length') || 0);
		if (declared > maxBytes) throw new UnsafeUrlError('That image is larger than 20 MB.');

		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = res.body?.getReader();
		if (!reader) throw new UnsafeUrlError('The image link returned no data.');
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new UnsafeUrlError('That image is larger than 20 MB.');
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	}
	throw new UnsafeUrlError('The image link redirected too many times.');
}
