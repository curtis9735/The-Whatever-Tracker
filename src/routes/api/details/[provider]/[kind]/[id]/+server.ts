import { json } from '@sveltejs/kit';
import { fetchDetails, findExisting } from '$lib/server/services/provider-items';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, request }) => {
	const details = await fetchDetails(params.provider, params.kind, params.id, request.signal);
	const libraryId = findExisting(locals.user!.id, params.provider, params.kind, params.id);
	return json({ details, libraryId });
};
