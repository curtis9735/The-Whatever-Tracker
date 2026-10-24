import { viewSharedList } from '$lib/server/services/share-links';
import type { PageServerLoad } from './$types';

// Nothing here reads the session: a signed-in visitor sees exactly what anyone with the link sees
export const load: PageServerLoad = ({ params }) => {
	return { token: params.token, list: viewSharedList(params.token) };
};
