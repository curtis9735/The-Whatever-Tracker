import { error } from '@sveltejs/kit';
import { viewSharedItem } from '$lib/server/services/share-links';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	if (!/^\d+$/.test(params.id)) error(404, 'Not found');
	return { token: params.token, item: viewSharedItem(params.token, Number(params.id)) };
};
