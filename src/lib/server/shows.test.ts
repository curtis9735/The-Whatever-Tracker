import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shows-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { saveShares } = await import('./services/access');
const { isConcertList, listShows } = await import('./services/concerts');
const { addLog, createItem } = await import('./services/items');

function person(name: string) {
	const user = db()
		.insert(schema.users)
		.values({ username: name, displayName: name, passwordHash: 'x' })
		.returning()
		.get();
	return {
		user,
		concerts: createCategoryFromTemplate(user.id, 'concerts'),
		whiskey: createCategoryFromTemplate(user.id, 'whiskey')
	};
}

function setlist(over: Record<string, unknown> = {}) {
	return {
		setlist: {
			id: 'x',
			date: '2023-05-01',
			artist: 'A',
			venue: 'Wembley Stadium',
			city: 'London',
			country: 'GB',
			songs: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }],
			...over
		}
	};
}

describe('listShows', () => {
	const owner = person('owner');
	const sharee = person('sharee');
	const { category } = getCategoryById(owner.user.id, owner.concerts.id);
	const artist = (title: string, userId = owner.user.id) =>
		createItem(userId, { categoryId: owner.concerts.id, title });
	const log = (userId: number, itemId: number, date: string, extra = {}) =>
		addLog(userId, itemId, { date, ...extra }, category.statuses);

	const muse = artist('Muse');
	const ed = artist('Ed Sheeran');
	log(owner.user.id, muse.id, '2023-05-01', { rating: 90, external: setlist({ tour: 'Drones Tour' }) });
	log(owner.user.id, ed.id, '2024-07-04', { location: 'Lucas Oil Stadium, Indianapolis' });
	log(owner.user.id, muse.id, '2023-11-20', { rating: 70 });
	log(owner.user.id, ed.id, '2022-01-02');
	saveShares(owner.user.id, owner.concerts.id, [{ userId: sharee.user.id, role: 'edit' }]);
	log(sharee.user.id, muse.id, '2025-03-03', { location: 'Their own night' });
	// Not a concert list
	const bottle = createItem(owner.user.id, { categoryId: owner.whiskey.id, title: 'Talisker' });
	addLog(
		owner.user.id,
		bottle.id,
		{ date: '2024-01-01' },
		getCategoryById(owner.user.id, owner.whiskey.id).category.statuses
	);

	it('lists the viewer’s shows newest first, with year counts', () => {
		const r = listShows(owner.user.id, owner.concerts.id);
		expect(r.rows.map((s) => [s.date, s.artist])).toEqual([
			['2024-07-04', 'Ed Sheeran'],
			['2023-11-20', 'Muse'],
			['2023-05-01', 'Muse'],
			['2022-01-02', 'Ed Sheeran']
		]);
		expect(r.total).toBe(4);
		expect(r.years).toEqual([
			{ year: '2024', count: 1 },
			{ year: '2023', count: 2 },
			{ year: '2022', count: 1 }
		]);
	});

	it('reads the setlist: tour, place, song count; the log place wins', () => {
		const rows = listShows(owner.user.id, owner.concerts.id).rows;
		expect(rows.find((s) => s.date === '2023-05-01')).toMatchObject({
			tour: 'Drones Tour',
			place: 'Wembley Stadium, London',
			songs: 3,
			rating: 90
		});
		expect(rows.find((s) => s.date === '2024-07-04')).toMatchObject({
			place: 'Lucas Oil Stadium, Indianapolis',
			tour: null,
			songs: null
		});
	});

	it('shows only the viewer’s own logs, each way round', () => {
		expect(listShows(sharee.user.id, owner.concerts.id).rows.map((s) => s.place)).toEqual([
			'Their own night'
		]);
		expect(listShows(owner.user.id, owner.concerts.id).rows.some((s) => s.place === 'Their own night')).toBe(
			false
		);
	});

	it('searches artist, place and tour', () => {
		const q = (t: string) => listShows(owner.user.id, owner.concerts.id, { q: t }).rows.map((s) => s.date);
		expect(q('sheeran')).toEqual(['2024-07-04', '2022-01-02']);
		expect(q('wembley')).toEqual(['2023-05-01']);
		expect(q('indianapolis')).toEqual(['2024-07-04']);
		expect(q('drones')).toEqual(['2023-05-01']);
		expect(q('%')).toEqual([]);
	});

	it('paginates and applies the artist filters', () => {
		const p = listShows(owner.user.id, owner.concerts.id, { pageSize: 2, page: 2 });
		expect(p.rows.map((s) => s.date)).toEqual(['2023-05-01', '2022-01-02']);
		expect(p.total).toBe(4);
		expect(listShows(owner.user.id, owner.concerts.id, { favorite: true }).rows).toEqual([]);
	});

	it('is empty for a list that isn’t a concert list or isn’t visible', () => {
		expect(isConcertList(owner.user.id, owner.whiskey.id)).toBe(false);
		expect(listShows(owner.user.id, owner.whiskey.id)).toEqual({ rows: [], total: 0, years: [] });
		const stranger = person('stranger');
		expect(listShows(stranger.user.id, owner.concerts.id).total).toBe(0);
	});
});
