import fs from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { absoluteUploadPath } from '$lib/server/images/store';
import { sharedImageFile } from '$lib/server/services/share-links';
import type { RequestHandler } from './$types';

// Photos of a shared list's items only, found through the link's token: /media itself stays private
export const GET: RequestHandler = async ({ params, url, request }) => {
	if (!/^\d+$/.test(params.imageId)) error(404, 'Not found');
	const rel = sharedImageFile(
		params.token,
		Number(params.imageId),
		url.searchParams.get('size') === 'thumb' ? 'thumb' : 'full'
	);
	if (!rel) error(404, 'Not found');

	const etag = `"${rel.split('/').pop()}"`;
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, {
			status: 304,
			headers: { 'Cache-Control': 'private, max-age=3600', ETag: etag }
		});
	}
	let data: Buffer;
	try {
		data = await fs.readFile(absoluteUploadPath(rel));
	} catch {
		error(404, 'Not found');
	}
	return new Response(new Uint8Array(data), {
		headers: {
			'Content-Type': 'image/webp',
			'Content-Length': String(data.byteLength),
			// Short, so turning the link off soon stops browsers showing the photos
			'Cache-Control': 'private, max-age=3600',
			ETag: etag
		}
	});
};
