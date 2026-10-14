import { json } from '@sveltejs/kit';
import { rawDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** For the container's health check. Public, so it says nothing about the app or its version. */
export const GET: RequestHandler = async () => {
	try {
		rawDb().prepare('SELECT 1').get();
		return json({ ok: true });
	} catch {
		return json({ ok: false }, { status: 503 });
	}
};
