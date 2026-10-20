import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-watching-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), TMDB_API_KEY: 'test-key' } };
});

const { db, rawDb, schema } = await import('./db');
const { createCategoryFromTemplate } = await import('./services/categories');
const { saveShares } = await import('./services/access');
const { createItem, deleteItem, getItem, getItemDetail, householdProgress, updateItem } =
	await import('./services/items');
const episodes = await import('./services/episodes');
const watching = await import('./services/watching');
const { DEFAULT_EPISODE_MINUTES, DEFAULT_MOVIE_MINUTES, FINISHED_SHOWN_MS } = await import('$lib/watching');

const MIN = 60_000;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
/** 8 PM on the 16th, in the server's time zone (the log's date is the check-in day) */
const EVENING = new Date(2026, 9, 16, 20, 0).getTime();

/** TMDB: shows with an even id are running, odd ones have ended; every movie runs 2h 13m */
const RUNNING = {
	show: {
		status: 'Returning Series',
		first_air_date: '2024-01-01',
		last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2026-10-14', runtime: 50 },
		next_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2026-10-21' },
		seasons: [
			{ season_number: 1, episode_count: 3, air_date: '2024-01-01' },
			{ season_number: 2, episode_count: 4, air_date: '2026-10-07' }
		]
	},
	seasons: {
		1: {
			season_number: 1,
			episodes: [1, 2, 3].map((n) => ({
				episode_number: n,
				air_date: `2024-01-0${n}`,
				name: `Pilot ${n}`,
				runtime: 42
			}))
		},
		2: {
			season_number: 2,
			episodes: [
				{ episode_number: 1, air_date: '2026-10-07', name: 'Back' },
				{ episode_number: 2, air_date: '2026-10-14', name: 'Again' }
			]
		}
	} as Record<number, unknown>
};
const ENDED = {
	show: {
		status: 'Ended',
		first_air_date: '2010-01-01',
		last_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2010-01-08' },
		seasons: [{ season_number: 1, episode_count: 2, air_date: '2010-01-01' }]
	},
	seasons: {
		1: {
			season_number: 1,
			episodes: [
				{ episode_number: 1, air_date: '2010-01-01', name: 'Start', runtime: 30 },
				{ episode_number: 2, air_date: '2010-01-08', name: 'Finale', runtime: 30 }
			]
		}
	} as Record<number, unknown>
};

let down = false;
let calls: string[] = [];
/** While set, TMDB answers only once it resolves */
let gate: Promise<void> | null = null;

beforeEach(() => {
	down = false;
	calls = [];
	gate = null;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => {
			const path = new URL(String(input)).pathname.replace('/3', '');
			calls.push(path);
			if (gate) await gate;
			if (down) throw new TypeError('fetch failed');
			const movie = path.match(/^\/movie\/(\d+)$/);
			if (movie) return json({ id: Number(movie[1]), title: 'A movie', runtime: 133 });
			const m = path.match(/^\/tv\/(\d+)(?:\/season\/(\d+))?$/);
			const shows = m && (Number(m[1]) % 2 === 0 ? RUNNING : ENDED);
			const body = shows && (m[2] === undefined ? shows.show : shows.seasons[Number(m[2])]);
			return body ? json(body) : new Response('{}', { status: 404 });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
let nextId = 1000;
/** Show ids step by 10 from an even one, so the first is running and the next has ended */
let nextShow = 5000;
function person(name = 'Daniel') {
	return db()
		.insert(schema.users)
		.values({ username: `w${++n}`, displayName: name, passwordHash: 'x' })
		.returning()
		.get();
}

/** A new account with Movies and TV Shows lists, a movie, a running show and one that has ended */
function account(status: string | null = 'planning') {
	const user = person();
	const movies = createCategoryFromTemplate(user.id, 'movies');
	const tv = createCategoryFromTemplate(user.id, 'tv-shows');
	const id = (nextShow += 10);
	const movie = (extra: Record<string, unknown> = {}) =>
		createItem(user.id, {
			categoryId: movies.id,
			title: 'The Movie',
			status,
			provider: 'tmdb',
			providerKind: 'movie',
			providerId: String((nextId += 1)),
			...extra
		});
	const show = (providerId: number, title: string) =>
		createItem(user.id, {
			categoryId: tv.id,
			title,
			status,
			provider: 'tmdb',
			providerKind: 'tv',
			providerId: String(providerId)
		});
	return { user, movies, tv, movie, running: show(id, 'The Show'), ended: show(id + 1, 'Old Show') };
}

const statusOf = (userId: number, itemId: number) => getItem(userId, itemId).status;
const logsOf = (userId: number, itemId: number) =>
	rawDb()
		.prepare('SELECT id, date FROM item_logs WHERE item_id = ? AND user_id = ? ORDER BY id')
		.all(itemId, userId) as { id: number; date: string }[];
const plays = (userId: number, itemId: number) =>
	rawDb()
		.prepare(
			'SELECT season, episode, title, log_id AS logId FROM episode_watches WHERE item_id = ? AND user_id = ? ORDER BY id'
		)
		.all(itemId, userId) as { season: number; episode: number; title: string | null; logId: number | null }[];
const row = (id: number) =>
	rawDb().prepare('SELECT * FROM checkins WHERE id = ?').get(id) as Record<string, unknown> | undefined;

async function expectStatus(fn: () => unknown, status: number) {
	try {
		await fn();
	} catch (e) {
		expect((e as { status?: number }).status).toBe(status);
		return;
	}
	throw new Error(`expected a ${status} error`);
}

describe('checking in to a movie', () => {
	it('sets Watching and runs for TMDB’s runtime', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		expect(live).toMatchObject({
			itemId: m.id,
			title: 'The Movie',
			kind: 'movie',
			season: null,
			durationMs: 133 * MIN,
			endsAt: EVENING + 133 * MIN,
			pausedAt: null,
			runtimeKnown: true,
			categorySlug: 'movies',
			categoryIcon: '🎬'
		});
		expect(statusOf(a.user.id, m.id)).toBe('watching');
		expect(watching.currentWatching(a.user.id, EVENING + MIN)).toMatchObject({
			live: { id: live.id },
			finished: null,
			now: EVENING + MIN
		});
	});

	it('assumes a usual length when TMDB fails, or goes by the saved runtime', async () => {
		const a = account();
		down = true;
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		expect(live).toMatchObject({ durationMs: DEFAULT_MOVIE_MINUTES * MIN, runtimeKnown: false });
		watching.cancelWatching(a.user.id, live.id, EVENING);
		const saved = a.movie({ metadata: { facts: [{ label: 'Runtime', value: '1h 30m' }] } });
		const again = await watching.startWatching(a.user.id, saved.id, null, {}, EVENING);
		expect(again).toMatchObject({ durationMs: 90 * MIN, runtimeKnown: true });
	});

	it('is marked watched when the time is up, dated the check-in day, and offered to rate or undo', async () => {
		const a = account();
		const m = a.movie();
		const late = new Date(2026, 9, 16, 23, 30).getTime();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, late);
		await watching.settleDue(late + 60 * MIN);
		expect(row(live.id)).toMatchObject({ ended_at: null });
		await watching.settleDue(live.endsAt);
		const logs = logsOf(a.user.id, m.id);
		// It ended after midnight, but was watched on the 16th
		expect(logs.map((l) => l.date)).toEqual(['2026-10-16']);
		expect(statusOf(a.user.id, m.id)).toBe('completed');
		const state = watching.currentWatching(a.user.id, live.endsAt + MIN);
		expect(state.live).toBeNull();
		expect(state.finished).toMatchObject({
			id: live.id,
			how: 'auto',
			logId: logs[0].id,
			statusLabel: 'Completed',
			title: 'The Movie'
		});
		// …for a few hours
		expect(watching.currentWatching(a.user.id, live.endsAt + FINISHED_SHOWN_MS + MIN).finished).toBeNull();
	});

	it('leaves a status changed meanwhile alone when it finishes', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		updateItem(a.user.id, m.id, { status: 'dropped' });
		await watching.settleMine(a.user.id, live.endsAt);
		expect(logsOf(a.user.id, m.id)).toHaveLength(1);
		expect(statusOf(a.user.id, m.id)).toBe('dropped');
		expect(watching.currentWatching(a.user.id, live.endsAt).finished?.statusLabel).toBeNull();
	});

	it('refuses items that aren’t movies or shows linked to TMDB, and a show without an episode', async () => {
		const a = account();
		const plain = createItem(a.user.id, { categoryId: a.movies.id, title: 'Home video' });
		await expect(watching.startWatching(a.user.id, plain.id, null)).rejects.toThrow(watching.WatchError);
		await expect(watching.startWatching(a.user.id, a.running.id, null)).rejects.toThrow(/Pick a season/);
		await expect(watching.startWatching(a.user.id, a.running.id, { season: 1, episode: 9 })).rejects.toThrow(
			/isn't in TMDB's episode list/
		);
		await expect(watching.startWatching(a.user.id, a.running.id, { season: 7, episode: 1 })).rejects.toThrow(
			/no Season 7/
		);
		expect(watching.currentWatching(a.user.id).live).toBeNull();
	});
});

describe('while it runs', () => {
	it('pausing stops the clock, and resuming moves the end later', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		await watching.pauseWatching(a.user.id, live.id, EVENING + 10 * MIN);
		await watching.pauseWatching(a.user.id, live.id, EVENING + 20 * MIN); // already paused: nothing changes
		expect(watching.currentWatching(a.user.id, EVENING + 30 * MIN).live).toMatchObject({
			pausedAt: EVENING + 10 * MIN,
			endsAt: live.endsAt
		});
		// A paused check-in never finishes on its own
		await watching.settleDue(live.endsAt + 600 * MIN);
		expect(row(live.id)).toMatchObject({ ended_at: null });
		// Paused for an hour
		watching.resumeWatching(a.user.id, live.id, EVENING + 70 * MIN);
		watching.resumeWatching(a.user.id, live.id, EVENING + 80 * MIN); // already running
		const resumed = watching.currentWatching(a.user.id, EVENING + 70 * MIN).live!;
		expect(resumed).toMatchObject({ pausedAt: null, endsAt: live.endsAt + 60 * MIN });
		await watching.settleDue(live.endsAt + 30 * MIN);
		expect(row(live.id)).toMatchObject({ ended_at: null });
		await watching.settleDue(live.endsAt + 61 * MIN);
		expect(row(live.id)).toMatchObject({ outcome: 'auto' });
		expect(logsOf(a.user.id, m.id)).toHaveLength(1);
	});

	it('cancelling puts the status back, unless it was changed meanwhile', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		watching.cancelWatching(a.user.id, live.id, EVENING + MIN);
		expect(statusOf(a.user.id, m.id)).toBe('planning');
		expect(row(live.id)).toMatchObject({ outcome: 'cancelled' });
		expect(logsOf(a.user.id, m.id)).toEqual([]);
		expect(watching.currentWatching(a.user.id, EVENING + MIN)).toMatchObject({ live: null, finished: null });

		const other = a.movie();
		const second = await watching.startWatching(a.user.id, other.id, null, {}, EVENING);
		updateItem(a.user.id, other.id, { status: 'dropped' });
		watching.cancelWatching(a.user.id, second.id, EVENING + MIN);
		expect(statusOf(a.user.id, other.id)).toBe('dropped');
	});

	it('leaves a status that was already Watching as it is', async () => {
		const a = account('watching');
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		expect(row(live.id)).toMatchObject({ status_before: 'watching', status_set: null });
		watching.cancelWatching(a.user.id, live.id, EVENING);
		expect(statusOf(a.user.id, m.id)).toBe('watching');
	});

	it('"Mark watched now" adds the log right away', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		const done = await watching.finishWatching(a.user.id, live.id, EVENING + 5 * MIN);
		expect(done).toMatchObject({ id: live.id, how: 'early', statusLabel: 'Completed' });
		expect(logsOf(a.user.id, m.id)).toEqual([{ id: done!.logId, date: '2026-10-16' }]);
		expect(statusOf(a.user.id, m.id)).toBe('completed');
		// A stale page asking again is told it already ended
		await expectStatus(() => watching.finishWatching(a.user.id, live.id, EVENING + 6 * MIN), 409);
		await expectStatus(() => watching.pauseWatching(a.user.id, live.id, EVENING + 6 * MIN), 409);
		expect(logsOf(a.user.id, m.id)).toHaveLength(1);
	});

	it('only the person’s own check-in can be changed', async () => {
		const a = account();
		const b = account();
		const live = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING);
		await expectStatus(() => watching.pauseWatching(b.user.id, live.id, EVENING), 404);
		await expectStatus(() => watching.finishWatching(b.user.id, live.id, EVENING), 404);
		await expectStatus(() => watching.cancelWatching(b.user.id, live.id, EVENING), 404);
		await expectStatus(() => watching.undoFinished(b.user.id, live.id), 404);
		expect(row(live.id)).toMatchObject({ ended_at: null, paused_at: null });
	});
});

describe('checking in to an episode', () => {
	it('marks the episode watched with a log, keeps the show Watching, and moves on to the next', async () => {
		const a = account();
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{},
			EVENING
		);
		expect(live).toMatchObject({
			kind: 'episode',
			season: 1,
			episode: 1,
			episodeTitle: 'Pilot 1',
			durationMs: 42 * MIN,
			runtimeKnown: true,
			categorySlug: 'tv-shows'
		});
		expect(statusOf(a.user.id, a.running.id)).toBe('watching');
		await watching.settleDue(live.endsAt);
		const p = plays(a.user.id, a.running.id);
		expect(p).toMatchObject([{ season: 1, episode: 1, title: 'Pilot 1' }]);
		expect(p[0].logId).not.toBeNull();
		expect(logsOf(a.user.id, a.running.id)).toEqual([{ id: p[0].logId, date: '2026-10-16' }]);
		expect(statusOf(a.user.id, a.running.id)).toBe('watching');
		const finished = watching.currentWatching(a.user.id, live.endsAt).finished;
		// It was Watching all along, so the status didn't change on finishing
		expect(finished).toMatchObject({ logId: p[0].logId, statusLabel: null, episodeTitle: 'Pilot 1' });
		const view = await episodes.loadTracker(
			a.user.id,
			episodes.trackedShow(a.user.id, a.running.id),
			'2026-10-16'
		);
		expect(view).toMatchObject({ ok: true, next: { season: 1, episode: 2, title: 'Pilot 2', runtime: 42 } });
	});

	it('uses the show’s usual episode length when the episode has none, or a default', async () => {
		const a = account();
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 2, episode: 1 },
			{},
			EVENING
		);
		expect(live).toMatchObject({ durationMs: 50 * MIN, runtimeKnown: true, episodeTitle: 'Back' });
		watching.cancelWatching(a.user.id, live.id, EVENING);
		// TMDB down with nothing saved: a usual length, unnamed
		const b = account();
		down = true;
		const blind = await watching.startWatching(b.user.id, b.ended.id, { season: 1, episode: 1 }, {}, EVENING);
		expect(blind).toMatchObject({
			durationMs: DEFAULT_EPISODE_MINUTES * MIN,
			runtimeKnown: false,
			episodeTitle: null
		});
	});

	it('the last episode of a show that has ended sets Completed', async () => {
		const a = account('watching');
		await episodes.watchEpisode(a.user.id, a.ended.id, { season: 1, episode: 1 }, null, '2026-10-16');
		const live = await watching.startWatching(a.user.id, a.ended.id, { season: 1, episode: 2 }, {}, EVENING);
		const done = await watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		expect(done).toMatchObject({ statusLabel: 'Completed', how: 'early', episodeTitle: 'Finale' });
		expect(statusOf(a.user.id, a.ended.id)).toBe('completed');
	});

	it('finishing doesn’t need TMDB for the episode’s name', async () => {
		const a = account();
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 3 },
			{},
			EVENING
		);
		down = true;
		calls = [];
		await watching.settleDue(live.endsAt);
		expect(plays(a.user.id, a.running.id)).toMatchObject([{ season: 1, episode: 3, title: 'Pilot 3' }]);
		// The episode's own season isn't asked for its name (the status check may look at the latest season)
		expect(calls.filter((c) => c.endsWith('/season/1'))).toEqual([]);
		expect(row(live.id)).toMatchObject({ outcome: 'auto' });
	});

	it('an episode unnamed at check-in (TMDB down) is named when it finishes, if TMDB answers then', async () => {
		const a = account();
		down = true;
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 2 },
			{},
			EVENING
		);
		expect(live.episodeTitle).toBeNull();
		down = false;
		await watching.settleDue(live.endsAt);
		expect(plays(a.user.id, a.running.id)).toMatchObject([{ season: 1, episode: 2, title: 'Pilot 2' }]);
		expect(row(live.id)).toMatchObject({ outcome: 'auto' });

		// Still down: marked watched all the same, unnamed
		const b = account();
		down = true;
		const blind = await watching.startWatching(b.user.id, b.ended.id, { season: 1, episode: 1 }, {}, EVENING);
		await expect(watching.settleDue(blind.endsAt)).resolves.toBeUndefined();
		expect(plays(b.user.id, b.ended.id)).toMatchObject([{ season: 1, episode: 1, title: null }]);
		expect(row(blind.id)).toMatchObject({ outcome: 'auto' });
	});
});

describe('one check-in at a time', () => {
	it('says what is running, and can mark it watched or cancel it first', async () => {
		const a = account();
		const first = a.movie();
		const second = a.movie();
		const live = await watching.startWatching(a.user.id, first.id, null, {}, EVENING);
		const err = await watching.startWatching(a.user.id, second.id, null, {}, EVENING).catch((e) => e);
		expect(err).toBeInstanceOf(watching.WatchConflict);
		expect(err).toMatchObject({ title: 'The Movie', label: null, itemId: first.id });

		// The same one again (a double tap) is the running one
		const again = await watching.startWatching(a.user.id, first.id, null, {}, EVENING + MIN);
		expect(again.id).toBe(live.id);

		const next = await watching.startWatching(
			a.user.id,
			second.id,
			null,
			{ replace: 'finish' },
			EVENING + MIN
		);
		expect(row(live.id)).toMatchObject({ outcome: 'early' });
		expect(logsOf(a.user.id, first.id)).toHaveLength(1);
		expect(statusOf(a.user.id, first.id)).toBe('completed');
		expect(watching.currentWatching(a.user.id, EVENING + MIN).live?.id).toBe(next.id);

		// An episode conflict names the episode
		const ep = await watching
			.startWatching(a.user.id, a.running.id, { season: 1, episode: 1 }, {}, EVENING + MIN)
			.catch((e) => e);
		expect(ep).toBeInstanceOf(watching.WatchConflict);
		const show = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{ replace: 'cancel' },
			EVENING + 2 * MIN
		);
		expect(row(next.id)).toMatchObject({ outcome: 'cancelled' });
		expect(logsOf(a.user.id, second.id)).toEqual([]);
		expect(statusOf(a.user.id, second.id)).toBe('planning');
		const other = await watching
			.startWatching(a.user.id, a.running.id, { season: 1, episode: 2 }, {}, EVENING + 3 * MIN)
			.catch((e) => e);
		expect(other).toMatchObject({ title: 'The Show', label: 'S1 E1 · Pilot 1' });
		expect(watching.currentWatching(a.user.id, EVENING + 3 * MIN).live?.id).toBe(show.id);
	});

	it('a new check-in closes the last “Watched” card', async () => {
		const a = account();
		const live = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING);
		await watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		expect(watching.currentWatching(a.user.id, EVENING + MIN).finished?.id).toBe(live.id);
		const next = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING + 2 * MIN);
		watching.cancelWatching(a.user.id, next.id, EVENING + 3 * MIN);
		expect(watching.currentWatching(a.user.id, EVENING + 3 * MIN)).toMatchObject({
			live: null,
			finished: null
		});
	});

	it('is finished once when the scheduler and a page load settle it together', async () => {
		const a = account();
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 2 },
			{},
			EVENING
		);
		await Promise.all([
			watching.settleDue(live.endsAt),
			watching.settleMine(a.user.id, live.endsAt),
			watching.finishWatching(a.user.id, live.id, live.endsAt).catch(() => null)
		]);
		expect(plays(a.user.id, a.running.id)).toHaveLength(1);
		expect(logsOf(a.user.id, a.running.id)).toHaveLength(1);
	});
});

describe('after it finished', () => {
	it('Undo takes the log back and puts the status back, once', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		await watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		await watching.undoFinished(a.user.id, live.id);
		expect(logsOf(a.user.id, m.id)).toEqual([]);
		expect(statusOf(a.user.id, m.id)).toBe('planning');
		expect(watching.currentWatching(a.user.id, EVENING + MIN).finished).toBeNull();
		// Again: harmless
		updateItem(a.user.id, m.id, { status: 'completed' });
		await watching.undoFinished(a.user.id, live.id);
		expect(statusOf(a.user.id, m.id)).toBe('completed');
	});

	it('Undo of an episode removes its play and puts a planned show back', async () => {
		const a = account();
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{},
			EVENING
		);
		await watching.settleMine(a.user.id, live.endsAt);
		expect(plays(a.user.id, a.running.id)).toHaveLength(1);
		await watching.undoFinished(a.user.id, live.id);
		expect(plays(a.user.id, a.running.id)).toEqual([]);
		expect(logsOf(a.user.id, a.running.id)).toEqual([]);
		expect(statusOf(a.user.id, a.running.id)).toBe('planning');
	});

	it('Undo leaves a status changed since alone', async () => {
		const a = account();
		const m = a.movie();
		const live = await watching.startWatching(a.user.id, m.id, null, {}, EVENING);
		await watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		updateItem(a.user.id, m.id, { status: 'dropped' });
		await watching.undoFinished(a.user.id, live.id);
		expect(logsOf(a.user.id, m.id)).toEqual([]);
		expect(statusOf(a.user.id, m.id)).toBe('dropped');
	});

	it('isn’t shown as watched or undone while it’s still being saved', async () => {
		const a = account();
		down = true;
		const live = await watching.startWatching(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{},
			EVENING
		);
		down = false;
		let release!: () => void;
		gate = new Promise((r) => (release = r));
		// Waits on TMDB for the episode's name
		const finishing = watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		expect(row(live.id)).toMatchObject({ outcome: 'finishing' });
		expect(watching.currentWatching(a.user.id, EVENING + MIN)).toMatchObject({ live: null, finished: null });
		const err = await watching.undoFinished(a.user.id, live.id).catch((e) => e);
		expect(err).toBeInstanceOf(watching.WatchError);
		expect(err).toMatchObject({ status: 409, message: 'Still saving, try again in a moment.' });
		// Nobody else finishes it meanwhile
		await watching.settleMine(a.user.id, live.endsAt);
		release();
		gate = null;
		expect(await finishing).toMatchObject({ id: live.id, how: 'early' });
		expect(plays(a.user.id, a.running.id)).toHaveLength(1);
		expect(watching.currentWatching(a.user.id, EVENING + 2 * MIN).finished?.id).toBe(live.id);
		await watching.undoFinished(a.user.id, live.id);
		expect(plays(a.user.id, a.running.id)).toEqual([]);
		expect(statusOf(a.user.id, a.running.id)).toBe('planning');
	});

	it('dismissing hides the card', async () => {
		const a = account();
		const live = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING);
		await watching.finishWatching(a.user.id, live.id, EVENING + MIN);
		watching.dismissFinished(a.user.id, live.id);
		expect(watching.currentWatching(a.user.id, EVENING + 2 * MIN).finished).toBeNull();
	});
});

describe('shared lists', () => {
	function shared() {
		const owner = person('Daniel');
		const viewer = person('Vic');
		const outsider = person('Otto');
		const movies = createCategoryFromTemplate(owner.id, 'movies');
		saveShares(owner.id, movies.id, [{ userId: viewer.id, role: 'view' }]);
		const movie = createItem(owner.id, {
			categoryId: movies.id,
			title: 'Shared Movie',
			status: 'planning',
			provider: 'tmdb',
			providerKind: 'movie',
			providerId: String((nextId += 1))
		});
		return { owner, viewer, outsider, movies, movie };
	}

	it('someone it’s shared with to view can check in, with their own status and log', async () => {
		const h = shared();
		const live = await watching.startWatching(h.viewer.id, h.movie.id, null, {}, EVENING);
		expect(live.categorySlug).toBe(`movies@${h.owner.username}`);
		expect(statusOf(h.viewer.id, h.movie.id)).toBe('watching');
		expect(statusOf(h.owner.id, h.movie.id)).toBe('planning');

		// The owner sees them watching, even while they have no status
		updateItem(h.viewer.id, h.movie.id, { status: null });
		const others = householdProgress(h.owner.id, getItem(h.owner.id, h.movie.id), EVENING + MIN);
		expect(others).toHaveLength(1);
		expect(others[0]).toMatchObject({
			userId: h.viewer.id,
			status: null,
			watching: { season: null, endsAt: live.endsAt, pausedAt: null, durationMs: 133 * MIN }
		});
		expect(getItemDetail(h.viewer.id, h.movie.id).household[0]).toMatchObject({
			owner: true,
			watching: null
		});
		updateItem(h.viewer.id, h.movie.id, { status: 'watching' });

		await watching.settleDue(live.endsAt);
		expect(logsOf(h.viewer.id, h.movie.id)).toHaveLength(1);
		expect(logsOf(h.owner.id, h.movie.id)).toEqual([]);
		const progress = rawDb()
			.prepare('SELECT status FROM item_progress WHERE item_id = ? AND user_id = ?')
			.get(h.movie.id, h.viewer.id);
		expect(progress).toEqual({ status: 'completed' });
		expect(statusOf(h.owner.id, h.movie.id)).toBe('planning');
		expect(householdProgress(h.owner.id, getItem(h.owner.id, h.movie.id))[0].watching).toBeNull();
	});

	it('someone it isn’t shared with can’t', async () => {
		const h = shared();
		await expectStatus(() => watching.startWatching(h.outsider.id, h.movie.id, null, {}, EVENING), 404);
	});

	it('an item deleted while watching leaves nothing behind', async () => {
		const h = shared();
		const live = await watching.startWatching(h.owner.id, h.movie.id, null, {}, EVENING);
		await deleteItem(h.owner.id, h.movie.id);
		expect(row(live.id)).toBeUndefined();
		expect(watching.currentWatching(h.owner.id, EVENING)).toMatchObject({ live: null, finished: null });
	});

	it('a list unshared while watching ends the check-in quietly, and puts the status back', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const h = shared();
		const progress = () =>
			rawDb()
				.prepare('SELECT status FROM item_progress WHERE item_id = ? AND user_id = ?')
				.get(h.movie.id, h.viewer.id);
		const live = await watching.startWatching(h.viewer.id, h.movie.id, null, {}, EVENING);
		// They had no status of their own before
		expect(row(live.id)).toMatchObject({ status_before: null, status_set: 'watching' });
		expect(progress()).toEqual({ status: 'watching' });
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: null }]);
		expect(watching.currentWatching(h.viewer.id, EVENING + MIN)).toMatchObject({
			live: null,
			finished: null
		});
		expect(row(live.id)).toMatchObject({ outcome: 'cancelled' });
		expect(progress()).toEqual({ status: null });

		// …and when the time runs out before anyone looks
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: 'view' }]);
		const second = await watching.startWatching(h.viewer.id, h.movie.id, null, {}, EVENING + 2 * MIN);
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: null }]);
		await expect(watching.settleDue(second.endsAt)).resolves.toBeUndefined();
		expect(row(second.id)).toMatchObject({ outcome: 'cancelled' });
		expect(logsOf(h.viewer.id, h.movie.id)).toEqual([]);
		expect(progress()).toEqual({ status: null });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();

		// A status changed meanwhile stays
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: 'view' }]);
		const third = await watching.startWatching(h.viewer.id, h.movie.id, null, {}, EVENING + 3 * MIN);
		updateItem(h.viewer.id, h.movie.id, { status: 'dropped' });
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: null }]);
		watching.currentWatching(h.viewer.id, EVENING + 4 * MIN);
		expect(row(third.id)).toMatchObject({ outcome: 'cancelled' });
		expect(progress()).toEqual({ status: 'dropped' });
	});

	it('a check-in on a list no longer shared never stands in the way of a new one', async () => {
		const h = shared();
		const live = await watching.startWatching(h.viewer.id, h.movie.id, null, {}, EVENING);
		saveShares(h.owner.id, h.movies.id, [{ userId: h.viewer.id, role: null }]);
		const own = createCategoryFromTemplate(h.viewer.id, 'movies');
		const mine = createItem(h.viewer.id, {
			categoryId: own.id,
			title: 'My Movie',
			status: 'planning',
			provider: 'tmdb',
			providerKind: 'movie',
			providerId: String((nextId += 1))
		});
		const next = await watching.startWatching(h.viewer.id, mine.id, null, {}, EVENING + MIN);
		expect(next.itemId).toBe(mine.id);
		expect(row(live.id)).toMatchObject({ outcome: 'cancelled' });
	});
});

describe('clearing up', () => {
	it('removes check-ins that ended over 30 days ago', async () => {
		const a = account();
		const old = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING);
		watching.cancelWatching(a.user.id, old.id, EVENING);
		const recent = await watching.startWatching(a.user.id, a.movie().id, null, {}, EVENING + 20 * 86_400_000);
		watching.cancelWatching(a.user.id, recent.id, EVENING + 20 * 86_400_000);
		await watching.settleDue(EVENING + 31 * 86_400_000);
		expect(row(old.id)).toBeUndefined();
		expect(row(recent.id)).toBeDefined();
	});
});
