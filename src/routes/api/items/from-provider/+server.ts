import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { addFromProvider } from '$lib/server/services/provider-items';
import { findCategoryForKind } from '$lib/server/services/categories';
import { toStored } from '$lib/ratings';
import type { RequestHandler } from './$types';

const Body = z.object({
	provider: z.string().max(40),
	kind: z.string().max(40),
	id: z.string().max(100),
	/** Left out: the first list the viewer can add to that takes this kind */
	categoryId: z.number().int().positive().nullish(),
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
	const userId = locals.user!.id;
	// Only into lists the viewer can edit: their own, or ones shared with them to edit
	const categoryId = b.categoryId ?? findCategoryForKind(userId, `${b.provider}:${b.kind}`)?.id;
	if (!categoryId) error(400, 'Pick a list to add it to.');
	const result = await addFromProvider(userId, {
		...b,
		categoryId,
		rating: toStored(b.rating)
	});
	return json(result, { status: result.created ? 201 : 200 });
};
