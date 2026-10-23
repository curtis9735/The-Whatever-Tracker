import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-journal-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, rawDb, schema } = await import('./db');
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

describe('journal with imported listening', () => {
	const fan = person('fan');
	const albums = createCategoryFromTemplate(fan.user.id, 'albums');
	const album = (title: string, cover = true) => {
		const item = createItem(fan.user.id, { categoryId: albums.id, title });
		if (cover) {
			const img = rawDb()
				.prepare(
					`INSERT INTO images (user_id, item_id, kind, source_url, sort_order, created_at)
					 VALUES (?, ?, 'url_link', ?, 0, 1) RETURNING id`
				)
				.get(fan.user.id, item.id, `https://img.example/${encodeURIComponent(title)}.png`) as { id: number };
			rawDb().prepare('UPDATE items SET cover_image_id = ? WHERE id = ?').run(img.id, item.id);
		}
		return item;
	};
	/** A day of listening, as the importer writes it */
	const listened = (title: string, date: string, plays: number, cover = true) => {
		const item = album(title, cover);
		rawDb()
			.prepare(
				`INSERT INTO item_logs (item_id, user_id, date, custom, external, source, source_key, created_at)
				 VALUES (?, ?, ?, '{}', ?, 'lastfm', ?, 1)`
			)
			.run(item.id, fan.user.id, date, JSON.stringify({ lastfm: { plays } }), `${item.id}:${date}`);
		return item;
	};
	fan.log(fan.whiskey.id, 'Ardbeg 10', '2026-10-12');
	listened('Alpha', '2026-10-12', 7);
	listened('Beta', '2026-10-12', 4);
	listened('Gamma', '2026-10-13', 3);
	for (const [i, name] of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].entries()) {
		listened(name, '2026-10-10', 10 - i, name !== 'L2');
	}
	const run = (mode: 'group' | 'hide' | 'all', list: number | null = null) =>
		journal(fan.user.id, resolveRange({ range: 'last-30-days' }, TODAY), TODAY, list, 100, mode);

	it('shows every album, with how many tracks each was played', () => {
		const r = run('all');
		expect(r.stats.total).toBe(10); // 9 albums and the whiskey
		const alpha = r.entries.find((e) => e.kind === 'log' && e.title === 'Alpha');
		expect(alpha).toMatchObject({ plays: 7, date: '2026-10-12' });
		expect(r.entries.find((e) => e.kind === 'log' && e.title === 'Ardbeg 10')).toMatchObject({ plays: null });
		expect(r.hasListening).toBe(true);
	});

	it('groups a listening day into one row, and counts it once in the stats and heatmap', () => {
		const r = run('group');
		expect(r.stats.total).toBe(4); // the whiskey and three listening days
		expect(r.stats.activeDays).toBe(3);
		expect(r.heat.weeks.flat().find((c) => c.date === '2026-10-12')!.count).toBe(2);
		expect(r.heat.weeks.flat().find((c) => c.date === '2026-10-13')!.count).toBe(1);
		expect(r.entries.map((e) => `${e.date} ${e.kind === 'log' ? e.title : 'listening'}`)).toEqual([
			'2026-10-13 listening',
			'2026-10-12 Ardbeg 10',
			'2026-10-12 listening',
			'2026-10-10 listening'
		]);
		expect(r.entries[0]).toMatchObject({ kind: 'listening', albums: 1, tracks: 3 });
		expect(r.entries[2]).toMatchObject({ kind: 'listening', albums: 2, tracks: 11 });
		expect(r.more).toBe(false);
	});

	it('shows up to four covers per day, most played first, skipping albums without one', () => {
		const day = run('group').entries.find((e) => e.kind === 'listening' && e.date === '2026-10-10');
		expect(day).toMatchObject({ albums: 6, tracks: 10 + 9 + 8 + 7 + 6 + 5 });
		const covers = (day as { covers: string[] }).covers;
		expect(covers).toHaveLength(4);
		expect(covers[0]).toContain('L1');
		expect(covers.join()).not.toContain('L2');
	});

	it('hides listening altogether', () => {
		const r = run('hide');
		expect(r.entries.map((e) => (e.kind === 'log' ? e.title : 'listening'))).toEqual(['Ardbeg 10']);
		expect(r.stats.total).toBe(1);
		expect(r.hasListening).toBe(true);
	});

	it('narrows a grouped day to one list', () => {
		const r = run('group', fan.whiskey.id);
		expect(r.entries.map((e) => e.kind)).toEqual(['log']);
		const albumsOnly = run('group', albums.id);
		expect(albumsOnly.entries.every((e) => e.kind === 'listening')).toBe(true);
		expect(albumsOnly.stats.total).toBe(3);
	});

	it('leaves the choice out for people with no imported listening', () => {
		expect(
			journal(
				person('plain').user.id,
				resolveRange({ range: 'last-30-days' }, TODAY),
				TODAY,
				null,
				100,
				'group'
			).hasListening
		).toBe(false);
	});

	it('pages grouped days like any other entries', () => {
		const r = journal(fan.user.id, resolveRange({ range: 'last-30-days' }, TODAY), TODAY, null, 2, 'group');
		expect(r.entries).toHaveLength(2);
		expect(r.more).toBe(true);
	});
});

describe('journal covers', () => {
	it('shows a picture shared by several albums once (repeats used to stop the page drawing)', () => {
		const twin = person('twin');
		const albums = createCategoryFromTemplate(twin.user.id, 'albums');
		// Two albums with the same artwork, and a third with its own, all played the same day
		for (const [title, url] of [
			['Twin A', 'https://img.example/shared.png'],
			['Twin B', 'https://img.example/shared.png'],
			['Solo', 'https://img.example/solo.png']
		]) {
			const item = createItem(twin.user.id, { categoryId: albums.id, title });
			const img = rawDb()
				.prepare(
					`INSERT INTO images (user_id, item_id, kind, source_url, sort_order, created_at)
					 VALUES (?, ?, 'url_link', ?, 0, 1) RETURNING id`
				)
				.get(twin.user.id, item.id, url) as { id: number };
			rawDb().prepare('UPDATE items SET cover_image_id = ? WHERE id = ?').run(img.id, item.id);
			rawDb()
				.prepare(
					`INSERT INTO item_logs (item_id, user_id, date, custom, external, source, source_key, created_at)
					 VALUES (?, ?, '2026-10-12', '{}', '{"lastfm":{"plays":3}}', 'lastfm', ?, 1)`
				)
				.run(item.id, twin.user.id, `${item.id}:2026-10-12`);
		}
		const r = journal(
			twin.user.id,
			resolveRange({ range: 'last-30-days' }, TODAY),
			TODAY,
			null,
			100,
			'group'
		);
		const day = r.entries.find((e) => e.kind === 'listening') as { albums: number; covers: string[] };
		expect(day.albums).toBe(3);
		expect(day.covers).toHaveLength(2);
		expect(new Set(day.covers).size).toBe(day.covers.length);
	});
});
