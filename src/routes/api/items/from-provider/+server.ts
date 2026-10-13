import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { addFromProvider } from '$lib/server/services/provider-items';
import { toStored } from '$lib/ratings';
import type { RequestHandler } from './$types';

const Body = z.object({
	provider: z.string().max(40),
	kind: z.string().max(40),
	id: z.string().max(100),
	categoryId: z.number().int().positive(),
	status: z.string().max(60).nullable(),
	/** Out of 10 */
	rating: z.number().min(0).max(10).nullable(),
	logDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const parsed = Body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Invalid request');
	const b = parsed.data;
	const result = await addFromProvider(locals.user!.id, {
		...b,
		rating: toStored(b.rating)
	});
	return json(result, { status: result.created ? 201 : 200 });
};
