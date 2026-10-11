import { json } from '@sveltejs/kit';
import { rawDb } from '$lib/server/db';
import { APP_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		rawDb().prepare('SELECT 1').get();
		return json({ ok: true, version: APP_VERSION });
	} catch {
		return json({ ok: false }, { status: 503 });
	}
};
