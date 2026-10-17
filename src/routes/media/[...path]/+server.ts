import fs from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { absoluteUploadPath, isSafeRelativePath } from '$lib/server/images/store';
import { canSeeUpload } from '$lib/server/services/access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, request }) => {
	const rel = params.path;
	if (!isSafeRelativePath(rel)) error(404, 'Not found');
	// Files live under u<userId>/, so ownership is part of the path. Someone else's photo is shown
	// when it's on an item (or a log of an item) on a list the viewer can see.
	const userId = locals.user!.id;
	if (!rel.startsWith(`u${userId}/`) && !canSeeUpload(userId, rel)) error(404, 'Not found');

	const etag = `"${rel.split('/').pop()}"`;
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
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
			// File names are random UUIDs and never reused
			'Cache-Control': 'private, max-age=31536000, immutable',
			ETag: etag
		}
	});
};
