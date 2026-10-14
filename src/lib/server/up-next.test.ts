import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-upnext-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById, updateCategory } = await import('./services/categories');
const { createItem, itemStrip } = await import('./services/items');

describe('Up next on the home page', () => {
	const user = db()
		.insert(schema.users)
		.values({ username: 'daniel', displayName: 'Daniel', passwordHash: 'x' })
		.returning()
		.get();
	const movies = createCategoryFromTemplate(user.id, 'movies');
	const whiskey = createCategoryFromTemplate(user.id, 'whiskey');

	createItem(user.id, { categoryId: movies.id, title: 'Dune', status: 'planning' });
	// A big imported wish list, all updated more recently than the movie
	for (let i = 0; i < 320; i++) {
		createItem(user.id, {
			categoryId: whiskey.id,
			title: `Whiskey ${i}`,
			status: 'wishlist',
			favorite: i === 0
		});
	}

	const titles = () => itemStrip(user.id, 'planned', 400).map((r) => r.title);

	it('shows planned items from every list by default', () => {
		expect(getCategoryById(user.id, whiskey.id).category.showUpNext).toBe(true);
		expect(titles()).toContain('Whiskey 319');
	});

	it('leaves out a list that has it turned off, without crowding out the others', () => {
		const { category } = getCategoryById(user.id, whiskey.id);
		updateCategory(user.id, whiskey.id, {
			name: category.name,
			icon: category.icon,
			color: category.color,
			statuses: category.statuses,
			providerKinds: category.providerKinds,
			showUpNext: false
		});
		expect(titles()).toEqual(['Dune']);
	});

	it('still shows favorites from that list', () => {
		expect(itemStrip(user.id, 'favorites').map((r) => r.title)).toEqual(['Whiskey 0']);
	});

	it('keeps the setting when a list is saved without mentioning it', () => {
		const { category } = getCategoryById(user.id, whiskey.id);
		updateCategory(user.id, whiskey.id, {
			name: 'Snug Whiskey List',
			icon: category.icon,
			color: category.color,
			statuses: category.statuses,
			providerKinds: category.providerKinds
		});
		expect(getCategoryById(user.id, whiskey.id).category.showUpNext).toBe(false);
	});
});
