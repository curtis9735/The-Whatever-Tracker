import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-journal-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { addLog, createItem } = await import('./services/items');
const { journal, logBounds } = await import('./services/journal');
const { resolveRange } = await import('$lib/journal');

const TODAY = '2026-10-14';

function person(name: string) {
	const user = db()
		.insert(schema.users)
		.values({ username: name, displayName: name, passwordHash: 'x' })
		.returning()
		.get();
	const whiskey = createCategoryFromTemplate(user.id, 'whiskey');
	const concerts = createCategoryFromTemplate(user.id, 'concerts');
	const log = (catId: number, title: string, date: string, extra = {}) => {
		const item = createItem(user.id, { categoryId: catId, title });
		const { category } = getCategoryById(user.id, catId);
		return addLog(user.id, item.id, { date, ...extra }, category.statuses);
	};
	return { user, whiskey, concerts, log };
}

describe('journal', () => {
	const daniel = person('daniel');
	const partner = person('partner');
	daniel.log(daniel.whiskey.id, 'Lagavulin 16', '2026-10-12', { rating: 90, location: 'The Snug' });
	daniel.log(daniel.whiskey.id, 'Talisker 10', '2026-10-13');
	daniel.log(daniel.concerts.id, 'Ed Sheeran', '2026-10-10', {
		location: 'Lucas Oil Stadium, Indianapolis, IN',
		external: {
			setlist: {
				id: 'x',
				date: '2026-10-10',
				artist: 'Ed Sheeran',
				venue: '',
				city: '',
				country: '',
				songs: [{ name: 'Shivers' }, { name: 'Perfect' }]
			}
		}
	});
	daniel.log(daniel.whiskey.id, 'Old bottle', '2024-01-05');
	partner.log(partner.whiskey.id, 'Partner only', '2026-10-13');

	it('shows only your own activity, newest first', () => {
		const r = journal(daniel.user.id, resolveRange({ range: 'last-30-days' }, TODAY), TODAY, null, 100);
		expect(r.entries.map((e) => e.title)).toEqual(['Talisker 10', 'Lagavulin 16', 'Ed Sheeran']);
		expect(r.stats.total).toBe(3);
		expect(r.stats.currentStreak).toBe(2); // Oct 12 and 13; nothing yet today
		expect(r.stats.longestStreak).toBe(2);
		expect(r.entries.find((e) => e.title === 'Ed Sheeran')).toMatchObject({
			setlistSongs: 2,
			categoryName: 'Concerts',
			location: 'Lucas Oil Stadium, Indianapolis, IN'
		});
		expect(r.entries.find((e) => e.title === 'Lagavulin 16')!.rating).toBe(90);
	});

	it('narrows to one list', () => {
		const r = journal(
			daniel.user.id,
			resolveRange({ range: 'last-30-days' }, TODAY),
			TODAY,
			daniel.concerts.id,
			100
		);
		expect(r.entries.map((e) => e.title)).toEqual(['Ed Sheeran']);
		expect(r.stats.currentStreak).toBe(0); // no concert yesterday or today
	});

	it('"All Time" reaches back to the first log', () => {
		const bounds = logBounds(daniel.user.id, null);
		expect(bounds).toEqual({ first: '2024-01-05', last: '2026-10-13' });
		const r = journal(daniel.user.id, resolveRange({ range: 'all-time' }, TODAY, bounds), TODAY, null, 100);
		expect(r.stats.total).toBe(4);
		expect(r.stats.activeDays).toBe(4);
	});

	it('pages through long ranges', () => {
		const r = journal(
			daniel.user.id,
			resolveRange({ range: 'all-time' }, TODAY, logBounds(daniel.user.id, null)),
			TODAY,
			null,
			2
		);
		expect(r.entries).toHaveLength(2);
		expect(r.more).toBe(true);
	});

	it("never mixes in another person's list, even when asked for it", () => {
		const r = journal(
			daniel.user.id,
			resolveRange({ range: 'last-30-days' }, TODAY),
			TODAY,
			partner.whiskey.id,
			100
		);
		expect(r.entries).toEqual([]);
	});
});
