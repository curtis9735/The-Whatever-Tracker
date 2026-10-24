import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-yperf-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, rawDb, schema } = await import('./db');
const categories = await import('./services/categories');
const { addLog, createItem } = await import('./services/items');
const { reviewYears, yearInReview } = await import('./services/year');
const { load } = await import('../../routes/(app)/year/[year]/+page.server');

const TODAY = '2026-10-14';
/** Plays in the year being reviewed, and in the year before it */
const PLAYS = 40_000;
const EARLIER = 20_000;
const ALBUMS = 3_000;
const HAND = 300;

/** Deterministic pseudo-random numbers, so every run sees the same history */
function rng(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const day = (year: number, n: number) => new Date(Date.UTC(year, 0, 1 + n)).toISOString().slice(0, 10);

describe('the year in review with 40,000 scrobbles in a year', () => {
	const user = db()
		.insert(schema.users)
		.values({ username: 'big', displayName: 'Big', passwordHash: 'x', onboarded: true })
		.returning()
		.get();
	const albums = categories.createCategoryFromTemplate(user.id, 'albums');
	const movies = categories.createCategoryFromTemplate(user.id, 'movies');

	it('sets up the history', () => {
		const sqlite = rawDb();
		const rand = rng(11);
		const insertItem = sqlite.prepare(
			'INSERT INTO items (user_id, category_id, title, custom, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1) RETURNING id'
		);
		const insertAlbum = sqlite.prepare(
			'INSERT INTO lastfm_albums (user_id, key, artist, title, item_id) VALUES (?, ?, ?, ?, ?) RETURNING id'
		);
		const insertPlay = sqlite.prepare(
			'INSERT INTO lastfm_scrobbles (user_id, uts, track_key, album_id, date, track) VALUES (?, ?, ?, ?, ?, ?)'
		);
		const insertLog = sqlite.prepare(
			`INSERT OR IGNORE INTO item_logs (item_id, user_id, date, custom, external, source, source_key, created_at)
			 VALUES (?, ?, ?, '{}', ?, 'lastfm', ?, 1)`
		);
		sqlite.transaction(() => {
			const ids: { item: number; album: number; artist: string }[] = [];
			for (let a = 0; a < ALBUMS; a++) {
				const item = insertItem.get(user.id, albums.id, `Album ${a}`, '{}') as { id: number };
				const artist = `Artist ${a % 900}`;
				const row = insertAlbum.get(user.id, `${artist}|Album ${a}`, artist, `Album ${a}`, item.id) as {
					id: number;
				};
				ids.push({ item: item.id, album: row.id, artist });
			}
			let uts = 1_500_000_000;
			for (const [year, total] of [
				[2025, EARLIER],
				[2026, PLAYS]
			] as const) {
				const days = year === 2026 ? 280 : 360;
				for (let n = 0; n < total; n++) {
					// Skewed so a few albums are played a lot, but all of them appear
					const a = ids[rand() < 0.5 ? Math.floor(rand() * ALBUMS) : Math.floor(rand() * rand() * ALBUMS)];
					const date = day(year, Math.floor((n / total) * days));
					const track = `Track ${n % 5000}`;
					insertPlay.run(
						user.id,
						uts++,
						`${a.artist.toLowerCase()}|${track.toLowerCase()}`,
						a.album,
						date,
						track
					);
					insertLog.run(a.item, user.id, date, JSON.stringify({ lastfm: { plays: 1 } }), `${a.item}:${date}`);
				}
			}
		})();
		const statuses = categories.getCategoryById(user.id, movies.id).category.statuses;
		for (let i = 0; i < HAND; i++) {
			const item = createItem(user.id, { categoryId: movies.id, title: `Movie ${i}` });
			addLog(
				user.id,
				item.id,
				{ date: day(2026, i % 270), rating: 80, location: `Place ${i % 40}` },
				statuses
			);
		}
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM lastfm_scrobbles').get() as { n: number }).n).toBe(
			PLAYS + EARLIER
		);
	}, 120_000);

	// Generous: this is about catching a return to scanning every play per question, not about the machine
	const BOUND_MS = 400;

	it('reads the years quickly', () => {
		const t = performance.now();
		expect(reviewYears(user.id, TODAY)).toEqual([2026, 2025]);
		expect(ms(t)).toBeLessThan(BOUND_MS);
	});

	it('reviews the year well under a second', () => {
		const t = performance.now();
		const r = yearInReview(user.id, 2026, TODAY);
		expect(ms(t)).toBeLessThan(BOUND_MS);
		expect(r.music).toMatchObject({ plays: PLAYS });
		expect(r.music!.topAlbums).toHaveLength(5);
		expect(r.music!.topTracks).toHaveLength(5);
		// Listening counts once a day, not once a play: 280 listening days and 300 movie logs
		expect(r.headline.logged).toBeLessThan(HAND + 281);
		expect(r.headline.logged).toBeGreaterThan(HAND);
		expect(r.lists.map((l) => l.name)).toEqual(['Movies']);
	});

	it('reads a year of plays through the date index', () => {
		const plan = (sql: string) =>
			(
				rawDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(user.id, '2026-01-01', '2026-12-31') as {
					detail: string;
				}[]
			)
				.map((r) => r.detail)
				.join('\n');
		for (const sql of [
			'SELECT date, COUNT(*) FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date',
			'SELECT COUNT(DISTINCT track_key) FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ?'
		]) {
			expect(plan(sql)).toContain('lastfm_scrobbles_user_date_idx');
		}
	});

	it('loads the page quickly, with a small payload', async () => {
		const t = performance.now();
		const page = (await load({
			locals: { user: { id: user.id } },
			params: { year: '2026' }
		} as never)) as { review: { headline: { logged: number } }; years: number[]; empty: boolean };
		expect(ms(t)).toBeLessThan(BOUND_MS * 2);
		expect(page.empty).toBe(false);
		expect(page.years).toContain(2026);
		expect(JSON.stringify(page).length).toBeLessThan(60_000);
	});
});
