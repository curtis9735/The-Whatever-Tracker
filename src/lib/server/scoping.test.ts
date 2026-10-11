import { beforeAll, describe, expect, it, vi } from 'vitest';

// Point the app at a throwaway data directory before anything opens the database
vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById, listCategories } = await import('./services/categories');
const items = await import('./services/items');
const { searchLocal } = await import('./search/local');
const yam = await import('./import/yamtrack');

function makeUser(username: string) {
	return db()
		.insert(schema.users)
		.values({ username, displayName: username, passwordHash: 'x' })
		.returning()
		.get();
}

async function expectStatus(fn: () => unknown, status: number) {
	try {
		await fn();
	} catch (e) {
		expect((e as { status?: number }).status).toBe(status);
		return;
	}
	throw new Error('expected an error');
}

describe('per-user data isolation', () => {
	let alice: { id: number };
	let bob: { id: number };
	let catId: number;
	let itemId: number;
	let imageId: number;

	beforeAll(async () => {
		alice = makeUser('alice');
		bob = makeUser('bob');
		const cat = createCategoryFromTemplate(alice.id, 'whiskey');
		catId = cat.id;
		const item = items.createItem(
			alice.id,
			{ categoryId: cat.id, title: 'Lagavulin 16', status: 'wishlist', custom: { distillery: 'Lagavulin' } },
			['peated']
		);
		itemId = item.id;
		const img = await items.addImage(
			alice.id,
			{ itemId },
			{ type: 'url', url: 'https://example.com/bottle.jpg', linkOnly: true }
		);
		imageId = img.id;
	});

	it('counts items per list', () => {
		const counts = Object.fromEntries(listCategories(alice.id).map((c) => [c.name, c.itemCount]));
		expect(counts).toEqual({ Whiskey: 1 });
	});

	it('the owner can find and read their item', () => {
		expect(searchLocal(alice.id, 'lagav').map((h) => h.id)).toEqual([itemId]);
		expect(searchLocal(alice.id, 'peated').map((h) => h.id)).toEqual([itemId]);
		expect(items.getItemDetail(alice.id, itemId).item.title).toBe('Lagavulin 16');
	});

	it('another user cannot see, search, list or touch it', async () => {
		expect(searchLocal(bob.id, 'lagav')).toEqual([]);
		expect(listCategories(bob.id)).toEqual([]);
		await expectStatus(() => items.getItemDetail(bob.id, itemId), 404);
		await expectStatus(() => getCategoryById(bob.id, catId), 404);
		await expectStatus(() => items.updateItem(bob.id, itemId, { title: 'pwned' }), 404);
		await expectStatus(() => items.addLog(bob.id, itemId, { date: '2026-01-01' }, []), 404);
		await expectStatus(() => items.deleteImage(bob.id, imageId), 404);
		await expectStatus(() => items.deleteItem(bob.id, itemId), 404);
		await expectStatus(() => items.createItem(bob.id, { categoryId: catId, title: 'Sneaky' }), 404);
		const { rows } = items.listItems(bob.id, catId, [], {});
		expect(rows).toEqual([]);
		expect(items.getItemDetail(alice.id, itemId).item.title).toBe('Lagavulin 16');
	});

	it('logging a planned item moves it to the first "done" status', () => {
		const { category } = getCategoryById(alice.id, catId);
		items.addLog(alice.id, itemId, { date: '2026-02-03', rating: 88, notes: 'smoky' }, category.statuses);
		const detail = items.getItemDetail(alice.id, itemId);
		expect(detail.item.status).toBe('finished');
		expect(detail.item.lastLoggedAt).toBe('2026-02-03');
		expect(searchLocal(alice.id, 'smoky').map((h) => h.id)).toEqual([itemId]);
	});
});

describe('Yamtrack import (database)', () => {
	const csv = [
		'media_id,source,media_type,title,image,season_number,episode_number,score,progress,status,start_date,end_date,notes',
		'438631,tmdb,movie,Dune,https://image.tmdb.org/t/p/w500/d5NX.jpg,,,8.5,1,Completed,,2021-10-22,',
		'1399,tmdb,season,Game of Thrones,,1,,9,10,Completed,2019-01-01,2019-01-20,',
		'1399,tmdb,episode,Game of Thrones,,1,10,,,,,2019-01-20,'
	].join('\n');

	it('creates lists, items and logs, and is idempotent', () => {
		const user = makeUser('carol');
		const plan = yam.planYamtrackImport(csv);
		const first = yam.applyYamtrackImport(user.id, plan);
		expect(first).toMatchObject({ created: 2, updated: 0, logsAdded: 2 });
		expect(first.createdCategories.sort()).toEqual(['Movies', 'TV Shows']);

		const again = yam.applyYamtrackImport(user.id, yam.planYamtrackImport(csv));
		expect(again).toMatchObject({ created: 0, updated: 2, logsAdded: 0, createdCategories: [] });

		const hits = searchLocal(user.id, 'thrones');
		expect(hits).toHaveLength(1);
		const got = items.getItemDetail(user.id, hits[0].id);
		expect(got.item.custom).toMatchObject({ current_season: 1, current_episode: 10 });
		expect(got.item.status).toBe('completed');
	});
});
