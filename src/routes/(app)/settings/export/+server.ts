import { asc, eq, inArray } from 'drizzle-orm';
import { getLastfmAccount } from '$lib/server/services/lastfm-sync';
import { db, rawDb, schema } from '$lib/server/db';
import { APP_VERSION } from '$lib/server/config';
import type { Image, ItemLog } from '$lib/server/db/schema';
import type { ShareRole } from '$lib/types';
import type { RequestHandler } from './$types';

interface SharedItemRow {
	id: number;
	title: string;
	subtitle: string | null;
	provider: string | null;
	providerKind: string | null;
	providerId: string | null;
	status: string | null;
	rating: number | null;
	favorite: number;
	notes: string | null;
	lastLoggedAt: string | null;
}

/**
 * The user's own progress on lists others share with them: for each list, the items they've tracked,
 * with their status, rating, favorite, notes, logs (and log photos) and TV episodes. The lists and
 * items themselves are in their owners' exports.
 */
function sharedProgress<E extends { itemId: number }>(
	userId: number,
	logs: ItemLog[],
	episodes: E[],
	images: Image[]
) {
	const sqlite = rawDb();
	const lists = sqlite
		.prepare(
			`SELECT c.id, c.name, u.username AS owner, s.role AS access FROM list_shares s
			 JOIN categories c ON c.id = s.category_id
			 JOIN users u ON u.id = c.user_id
			 WHERE s.user_id = ? ORDER BY c.name COLLATE NOCASE`
		)
		.all(userId) as { id: number; name: string; owner: string; access: ShareRole }[];
	const itemsOf = sqlite.prepare(
		`SELECT i.id, i.title, i.subtitle, i.provider, i.provider_kind AS providerKind,
			i.provider_id AS providerId, p.status, p.rating, COALESCE(p.favorite, 0) AS favorite, p.notes,
			p.last_logged_at AS lastLoggedAt
		 FROM items i LEFT JOIN item_progress p ON p.item_id = i.id AND p.user_id = ?
		 WHERE i.category_id = ? ORDER BY i.title COLLATE NOCASE`
	);
	return lists.map(({ id, ...list }) => ({
		...list,
		items: (itemsOf.all(userId, id) as SharedItemRow[])
			.map(({ id: itemId, favorite, ...i }) => ({
				...i,
				favorite: !!favorite,
				logs: logs
					.filter((l) => l.itemId === itemId)
					.map((l) => ({ ...l, images: images.filter((im) => im.logId === l.id) })),
				episodes: episodes.filter((e) => e.itemId === itemId).map((e) => ({ ...e, itemId: undefined }))
			}))
			// Only what they've tracked
			.filter(
				(i) =>
					i.status !== null ||
					i.rating !== null ||
					i.favorite ||
					i.notes !== null ||
					i.logs.length > 0 ||
					i.episodes.length > 0
			)
	}));
}

/**
 * Everything this user has tracked, as one JSON file (photos are referenced by path): their own lists,
 * and in `sharedWithMe` their own progress on lists others share with them.
 */
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
	const sharedWithMe = sharedProgress(userId, logs, episodes, images);
	// Only the connection itself; the plays are in the logs (and last.fm still has them all)
	const lastfm = getLastfmAccount(userId);

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
			})),
			...(lastfm
				? { lastfm: { username: lastfm.username, connectedAt: new Date(lastfm.connectedAt).toISOString() } }
				: {}),
			sharedWithMe
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
