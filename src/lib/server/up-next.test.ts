import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-upnext-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, rawDb, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById, updateCategory } = await import('./services/categories');
const { addLog, createItem, itemStrip, recentActivity } = await import('./services/items');

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

describe('Up next after a big last.fm import', () => {
	const user = db()
		.insert(schema.users)
		.values({ username: 'listener', displayName: 'Listener', passwordHash: 'x' })
		.returning()
		.get();
	const albums = createCategoryFromTemplate(user.id, 'albums');

	it('still shows planned albums when 500 newer listened ones fill the list', () => {
		for (const t of ['Wish A', 'Wish B', 'Wish C']) {
			createItem(user.id, { categoryId: albums.id, title: t, status: 'to-listen' });
		}
		for (let i = 0; i < 500; i++)
			createItem(user.id, { categoryId: albums.id, title: `Heard ${i}`, status: 'listened' });
		// Every imported album is newer than the wish list
		rawDb().prepare("UPDATE items SET updated_at = updated_at + 100000 WHERE status = 'listened'").run();
		expect(
			itemStrip(user.id, 'planned', 12)
				.map((r) => r.title)
				.sort()
		).toEqual(['Wish A', 'Wish B', 'Wish C']);
	});

	it('leaves imported listening out of recent activity', () => {
		const item = createItem(user.id, { categoryId: albums.id, title: 'Played Lots', status: 'listened' });
		const { category } = getCategoryById(user.id, albums.id);
		addLog(user.id, item.id, { date: '2026-10-01', notes: 'by hand' }, category.statuses);
		rawDb()
			.prepare(
				"INSERT INTO item_logs (item_id, user_id, date, external, source, source_key, created_at) VALUES (?, ?, '2026-10-20', '{\"lastfm\":{\"plays\":9}}', 'lastfm', '1:2026-10-20', ?)"
			)
			.run(item.id, user.id, Date.now());
		const dates = recentActivity(user.id).map((r) => r.date);
		expect(dates).toContain('2026-10-01');
		expect(dates).not.toContain('2026-10-20');
	});
});
