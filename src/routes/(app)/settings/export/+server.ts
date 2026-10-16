import { asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '$lib/server/db';
import { APP_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

/** Everything this user has tracked, as one JSON file (photos are referenced by path). */
export const GET: RequestHandler = async ({ locals }) => {
	const userId = locals.user!.id;
	const d = db();
	const categories = d
		.select()
		.from(schema.categories)
		.where(eq(schema.categories.userId, userId))
		.orderBy(asc(schema.categories.sortOrder))
		.all();
	const catIds = categories.map((c) => c.id);
	const fields = catIds.length
		? d
				.select()
				.from(schema.fieldDefinitions)
				.where(inArray(schema.fieldDefinitions.categoryId, catIds))
				.all()
		: [];
	const items = d.select().from(schema.items).where(eq(schema.items.userId, userId)).all();
	const logs = d.select().from(schema.itemLogs).where(eq(schema.itemLogs.userId, userId)).all();
	const images = d.select().from(schema.images).where(eq(schema.images.userId, userId)).all();
	// TV episodes watched (a check-in's date is on its log)
	const episodes = d
		.select({
			itemId: schema.episodeWatches.itemId,
			season: schema.episodeWatches.season,
			episode: schema.episodeWatches.episode,
			title: schema.episodeWatches.title,
			logId: schema.episodeWatches.logId,
			watchedAt: schema.episodeWatches.watchedAt,
			createdAt: schema.episodeWatches.createdAt
		})
		.from(schema.episodeWatches)
		.where(eq(schema.episodeWatches.userId, userId))
		.orderBy(asc(schema.episodeWatches.id))
		.all();
	const tags = d
		.select({ itemId: schema.itemTags.itemId, name: schema.tags.name })
		.from(schema.itemTags)
		.innerJoin(schema.tags, eq(schema.tags.id, schema.itemTags.tagId))
		.where(eq(schema.tags.userId, userId))
		.all();

	const body = JSON.stringify(
		{
			app: 'whatever-tracker',
			version: APP_VERSION,
			exportedAt: new Date().toISOString(),
			user: { username: locals.user!.username, displayName: locals.user!.displayName },
			categories: categories.map((c) => ({
				...c,
				fields: fields.filter((f) => f.categoryId === c.id)
			})),
			items: items.map((i) => ({
				...i,
				tags: tags.filter((t) => t.itemId === i.id).map((t) => t.name),
				logs: logs.filter((l) => l.itemId === i.id),
				episodes: episodes.filter((e) => e.itemId === i.id).map((e) => ({ ...e, itemId: undefined })),
				images: images.filter(
					(im) => im.itemId === i.id || logs.some((l) => l.id === im.logId && l.itemId === i.id)
				)
			}))
		},
		null,
		2
	);
	const date = new Date().toISOString().slice(0, 10);
	return new Response(body, {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Disposition': `attachment; filename="whatever-tracker-${locals.user!.username}-${date}.json"`
		}
	});
};
