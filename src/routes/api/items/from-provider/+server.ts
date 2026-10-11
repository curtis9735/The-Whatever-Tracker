import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { addFromProvider } from '$lib/server/services/provider-items';
import { getCategoryById } from '$lib/server/services/categories';
import { toStored } from '$lib/ratings';
import type { RequestHandler } from './$types';

const Body = z.object({
	provider: z.string().max(40),
	kind: z.string().max(40),
	id: z.string().max(100),
	categoryId: z.number().int().positive(),
	status: z.string().max(60).nullable(),
	/** In the category's display scale */
	rating: z.number().min(0).max(100).nullable(),
	logDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const parsed = Body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Invalid request');
	const b = parsed.data;
	const { category } = getCategoryById(locals.user!.id, b.categoryId);
	const result = await addFromProvider(locals.user!.id, {
		...b,
		rating: toStored(b.rating, category.ratingScale)
	});
	return json(result, { status: result.created ? 201 : 200 });
};
