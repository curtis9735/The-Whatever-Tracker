import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-jperf-'));
	return {
		env: {
			DATA_DIR: dir,
			MIGRATIONS_DIR: path.resolve('drizzle'),
			LASTFM_API_KEY: 'abcdef0123456789abcdef0123456789'
		}
	};
});

const { db, rawDb, schema } = await import('./db');
const categories = await import('./services/categories');
const { addLog, createItem } = await import('./services/items');
const sync = await import('./services/lastfm-sync');
const { setLastfmMinInterval } = await import('./providers/lastfm');
const { journal, logBounds } = await import('./services/journal');
const { resolveRange } = await import('$lib/journal');
const { todayIso } = await import('./forms');
const { load } = await import('../../routes/(app)/journal/+page.server');

setLastfmMinInterval(0);

const PLAYS = 40_000;
const ALBUMS = 3_000;
const DAYS = 1_200;
const SPAN_DAYS = 1_460;

interface Play {
	uts: number;
	artist: string;
	album: string;
	track: string;
}

/** Deterministic pseudo-random numbers, so every run sees the same history */
function rng(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

function bigHistory(): Play[] {
	const rand = rng(7);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	// DAYS distinct days spread over four years
	const days = new Set<number>();
	while (days.size < DAYS) days.add(1 + Math.floor(rand() * SPAN_DAYS));
	const sorted = [...days].sort((a, b) => a - b);
	const plays: Play[] = [];
	let n = 0;
	for (const [k, back] of sorted.entries()) {
		const base = new Date(today);
		base.setDate(base.getDate() - back);
		base.setHours(8, 0, 0, 0);
		const count = Math.round(PLAYS / DAYS) + (k % 3) - 1;
		for (let i = 0; i < count && n < PLAYS; i++, n++) {
			// Skewed so a few albums are played a lot, but all of them appear
			const a = rand() < 0.5 ? Math.floor(rand() * ALBUMS) : Math.floor(rand() * rand() * ALBUMS);
			plays.push({
				uts: Math.floor(base.getTime() / 1000) + i * 120,
				artist: `Artist ${a % 900}`,
				album: `Album ${a}`,
				track: `Track ${n}`
			});
		}
	}
	// Top up to exactly PLAYS on the last day
	while (plays.length < PLAYS) {
		const last = plays[plays.length - 1];
		plays.push({ ...last, uts: last.uts + 120, track: `Track ${plays.length}` });
	}
	return plays;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(plays: Play[]) {
	const sorted = [...plays].sort((a, b) => b.uts - a.uts);
	return async (input: string | URL) => {
		const url = new URL(String(input));
		const method = url.searchParams.get('method');
		if (method === 'user.getInfo')
			return json({
				user: { name: 'big', playcount: String(plays.length), registered: { unixtime: '1100000000' } }
			});
		const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : 0;
		const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : Infinity;
		const limit = Number(url.searchParams.get('limit') ?? 50);
		const all = sorted.filter((p) => p.uts >= from && p.uts <= to);
		const pageNo = Number(url.searchParams.get('page') ?? 1);
		const page = all.slice((pageNo - 1) * limit, pageNo * limit).map((p) => ({
			artist: { '#text': p.artist, mbid: '' },
			album: { '#text': p.album, mbid: '' },
			name: p.track,
			image: [{ size: 'extralarge', '#text': `https://img.example/${encodeURIComponent(p.album)}.png` }],
			date: { uts: String(p.uts), '#text': 'x' }
		}));
		return json({
			recenttracks: { track: page.length === 1 ? page[0] : page, '@attr': { total: String(all.length) } }
		});
	};
}

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const TODAY = todayIso();

describe('the journal with a 40,000-scrobble last.fm history', () => {
	const user = db()
		.insert(schema.users)
		.values({ username: 'big', displayName: 'Big', passwordHash: 'x', onboarded: true })
		.returning()
		.get();
	const list = categories.createCategoryFromTemplate(user.id, 'albums');
	const movies = categories.createCategoryFromTemplate(user.id, 'movies');
	const HAND = 150;
	const n = (sql: string, ...args: unknown[]) =>
		(
			rawDb()
				.prepare(sql)
				.get(...args) as { n: number }
		).n;

	// Generous bounds: this is about catching a return to scanning and sorting every log, not about
	// the machine. The same calls took 50-200 ms before the journal indexes, now a few ms to ~40 ms.
	const BOUND_MS = 400;

	it('imports it page by page without long stalls', async () => {
		const plays = bigHistory();
		expect(plays.length).toBe(PLAYS);
		vi.stubGlobal('fetch', vi.fn(fakeFetch(plays)));
		await sync.connectLastfm(user.id, { username: 'big', categoryId: list.id });
		let worst = 0;
		let last = 'more';
		for (let i = 0; i < 400 && last === 'more'; i++) {
			const t = performance.now();
			last = await sync.runPage(user.id);
			worst = Math.max(worst, ms(t));
		}
		vi.unstubAllGlobals();
		expect(last).toBe('done');
		// One page is one synchronous transaction: it must stay short enough that requests aren't stalled
		expect(worst).toBeLessThan(3000);
		expect(n('SELECT COUNT(*) AS n FROM lastfm_scrobbles')).toBe(PLAYS);
		expect(n('SELECT COUNT(*) AS n FROM lastfm_albums')).toBe(ALBUMS);
		expect(n("SELECT COUNT(DISTINCT date) AS n FROM item_logs WHERE source = 'lastfm'")).toBeGreaterThan(
			1100
		);

		// Hand-written logs, and ones with an `external` that isn't what the journal expects
		const statuses = categories.getCategoryById(user.id, movies.id).category.statuses;
		const day = (back: number) => {
			const d = new Date();
			d.setDate(d.getDate() - back);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		};
		for (let i = 0; i < HAND; i++) {
			const item = createItem(user.id, { categoryId: movies.id, title: `Movie ${i}` });
			addLog(user.id, item.id, { date: day(i * 9), rating: 80 }, statuses);
		}
		const odd = rawDb().prepare('UPDATE item_logs SET external = ? WHERE id = ?');
		const mine = rawDb()
			.prepare('SELECT id FROM item_logs WHERE source IS NULL AND user_id = ? ORDER BY id LIMIT 3')
			.all(user.id) as { id: number }[];
		odd.run('not json {', mine[0].id);
		odd.run('null', mine[1].id);
		odd.run('{"setlist":{},"lastfm":{"plays":"many"}}', mine[2].id);
	}, 120_000);

	const modes = ['group', 'all', 'hide'] as const;

	it('loads in any mode, range and list filter quickly, with the right shape', () => {
		const ranges = {
			'12m': resolveRange({ range: 'last-12-months' }, TODAY),
			'all-time': resolveRange({ range: 'all-time' }, TODAY, logBounds(user.id, null)),
			day: resolveRange({ from: day0(), to: day0() }, TODAY)
		};
		const perDay = new Map(
			(
				rawDb().prepare('SELECT date, COUNT(*) AS n FROM lastfm_scrobbles GROUP BY date').all() as {
					date: string;
					n: number;
				}[]
			).map((r) => [r.date, r.n])
		);
		const listeningLogs = n("SELECT COUNT(*) AS n FROM item_logs WHERE source = 'lastfm'");
		const listeningDays = n("SELECT COUNT(DISTINCT date) AS n FROM item_logs WHERE source = 'lastfm'");
		const handDays = n(
			'SELECT COUNT(*) AS n FROM item_logs WHERE source IS NULL AND date BETWEEN ? AND ?',
			ranges['all-time'].from,
			ranges['all-time'].to
		);
		expect(handDays).toBe(HAND);

		for (const mode of modes)
			for (const [name, range] of Object.entries(ranges))
				for (const filter of [null, list.id, movies.id]) {
					const t = performance.now();
					const r = journal(user.id, range, TODAY, filter, 120, mode);
					expect(ms(t), `${mode} ${name} ${filter}`).toBeLessThan(BOUND_MS);
					expect(r.entries.length).toBeLessThanOrEqual(120);
					expect(r.hasListening).toBe(filter !== movies.id);
					// Newest day first
					const dates = r.entries.map((e) => e.date);
					expect(dates).toEqual([...dates].sort().reverse());
					if (name === 'all-time') {
						const music =
							filter === movies.id
								? 0
								: mode === 'group'
									? listeningDays
									: mode === 'all'
										? listeningLogs
										: 0;
						const hand = filter === list.id ? 0 : HAND;
						expect(r.stats.total, `${mode} ${filter}`).toBe(music + hand);
					}
					if (mode === 'group') {
						for (const e of r.entries) {
							if (e.kind !== 'listening') continue;
							expect(e.covers.length).toBeLessThanOrEqual(4);
							expect(e.tracks).toBe(perDay.get(e.date));
						}
					} else {
						expect(r.entries.every((e) => e.kind === 'log')).toBe(true);
					}
				}
	}, 60_000);

	it('survives an external value that is not what it expects', () => {
		const r = journal(
			user.id,
			resolveRange({ range: 'all-time' }, TODAY, logBounds(user.id, null)),
			TODAY,
			movies.id,
			500,
			'hide'
		);
		expect(r.entries.length).toBe(HAND);
		expect(r.entries.every((e) => e.kind === 'log' && e.setlistSongs === null && e.plays === null)).toBe(
			true
		);
	});

	it('loads the whole page quickly', async () => {
		for (const q of [
			'',
			'?range=all-time',
			'?listening=all&range=all-time',
			'?listening=hide',
			'?limit=5000&range=all-time'
		]) {
			const t = performance.now();
			const r = (await load({
				locals: { user: { id: user.id } },
				url: new URL(`http://x/journal${q}`)
			} as never)) as { entries: unknown[]; heat: { weeks: unknown[] } };
			expect(ms(t), q).toBeLessThan(BOUND_MS * 2);
			expect(r.entries.length).toBeGreaterThan(0);
			expect(r.heat.weeks.length).toBeLessThanOrEqual(265);
			// What goes to the browser stays small
			if (!q.includes('limit')) expect(JSON.stringify(r).length).toBeLessThan(250_000);
		}
	}, 60_000);
});

function day0() {
	return TODAY;
}
