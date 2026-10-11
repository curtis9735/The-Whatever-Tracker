import { json } from '@sveltejs/kit';
import { searchLocal } from '$lib/server/search/local';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 200);
	return json({ hits: searchLocal(locals.user!.id, q, 20) });
};
