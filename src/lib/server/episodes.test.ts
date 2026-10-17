import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-episodes-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), TMDB_API_KEY: 'test-key' } };
});

const { db, rawDb, schema } = await import('./db');
const { createCategoryFromTemplate } = await import('./services/categories');
const { addLog, createItem, deleteLog, getItemDetail, getItem, listItems, recentActivity, updateItem } =
	await import('./services/items');
const episodes = await import('./services/episodes');
const { journal } = await import('./services/journal');
const { applyYamtrackImport, planYamtrackImport } = await import('./import/yamtrack');
const { cached, ProviderError } = await import('./providers/util');
const { logEpisodeLabel } = await import('$lib/episodes');

const today = '2026-10-16';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** TMDB: shows with an even id are running (season 1 out, season 2 half-way), odd ones have ended */
const RUNNING = {
	show: {
		status: 'Returning Series',
		first_air_date: '2024-01-01',
		last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2026-10-14' },
		next_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2026-10-21' },
		seasons: [
			{ season_number: 0, episode_count: 2, air_date: '2024-05-01' },
			{ season_number: 1, episode_count: 3, air_date: '2024-01-01' },
			{ season_number: 2, episode_count: 4, air_date: '2026-10-07' }
		]
	},
	seasons: {
		0: {
			season_number: 0,
			episodes: [
				{ episode_number: 1, air_date: '2024-05-01', name: 'Bonus' },
				{ episode_number: 2, air_date: '2026-12-25', name: 'Holiday special' }
			]
		},
		1: {
			season_number: 1,
			episodes: [1, 2, 3].map((n) => ({
				id: 1000 + n,
				episode_number: n,
				air_date: n < 3 ? `2024-01-0${n}` : null,
				name: `Pilot ${n}`,
				crew: [{ name: 'lots of data we do not keep' }]
			}))
		},
		2: {
			season_number: 2,
			episodes: [
				{ episode_number: 1, air_date: '2026-10-07', name: 'Back' },
				{ episode_number: 2, air_date: '2026-10-14', name: 'Again' },
				{ episode_number: 3, air_date: '2026-10-21', name: 'Soon' },
				{ episode_number: 4, air_date: null, name: 'TBA' }
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
				{ episode_number: 1, air_date: '2010-01-01', name: 'Start' },
				{ episode_number: 2, air_date: '2010-01-08', name: 'Finale' }
			]
		}
	} as Record<number, unknown>
};

let calls: string[] = [];
let down = false;
/** An episode TMDB adds to a running show's season 2 later on */
let added: unknown = null;
let nextShow = 500;

beforeEach(() => {
	calls = [];
	down = false;
	added = null;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => {
			const path = new URL(String(input)).pathname.replace('/3', '');
			calls.push(path);
			if (down) throw new TypeError('fetch failed');
			const m = path.match(/^\/tv\/(\d+)(?:\/season\/(\d+))?$/);
			const shows = m && (Number(m[1]) % 2 === 0 ? RUNNING : ENDED);
			let body = shows && (m[2] === undefined ? shows.show : shows.seasons[Number(m[2])]);
			if (added && shows === RUNNING && m?.[2] === '2') {
				const s2 = body as { episodes: unknown[] };
				body = { ...s2, episodes: [...s2.episodes, added] };
			}
			return body ? json(body) : new Response('{}', { status: 404 });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
/** A new account with a TV Shows list, a running show and one that has ended (fresh TMDB ids) */
function account(status = 'planning') {
	const id = (nextShow += 10);
	const user = db()
		.insert(schema.users)
		.values({ username: `ep${++n}`, displayName: 'x', passwordHash: 'x' })
		.returning()
		.get();
	const tv = createCategoryFromTemplate(user.id, 'tv-shows');
	const show = (providerId: number, title = 'The Show', custom: Record<string, unknown> = {}) =>
		createItem(user.id, {
			categoryId: tv.id,
			title,
			status,
			provider: 'tmdb',
			providerKind: 'tv',
			providerId: String(providerId),
			custom
		});
	return { user, tv, running: show(id), ended: show(id + 1, 'Old Show'), id, show };
}

const statusOf = (userId: number, itemId: number) => getItem(userId, itemId).status;
const plays = (itemId: number) =>
	rawDb()
		.prepare('SELECT season, episode, log_id AS logId FROM episode_watches WHERE item_id = ? ORDER BY id')
		.all(itemId) as { season: number; episode: number; logId: number | null }[];

describe('checking in an episode', () => {
	it('saves a log for that day with the episode, and starts a planned show', async () => {
		const a = account();
		const r = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{ date: today },
			today
		);
		expect(r).toMatchObject({
			season: 1,
			episode: 1,
			title: 'Pilot 1',
			duplicate: false,
			status: { key: 'watching' }
		});
		const detail = getItemDetail(a.user.id, a.running.id);
		expect(detail.logs).toHaveLength(1);
		expect(logEpisodeLabel(detail.logs[0].episodes)).toBe('S1 E1 · Pilot 1');
		expect(statusOf(a.user.id, a.running.id)).toBe('watching');
		expect(detail.item.lastLoggedAt).toBe(today);
	});

	it('treats a second tap on the same check-in as the same one', async () => {
		const a = account();
		const pick = { season: 1, episode: 2 };
		const first = await episodes.watchEpisode(a.user.id, a.running.id, pick, { date: today }, today, {
			quick: true
		});
		const again = await episodes.watchEpisode(a.user.id, a.running.id, pick, { date: today }, today, {
			quick: true
		});
		expect(again).toMatchObject({ duplicate: true, logId: first.logId, watchId: first.watchId });
		expect(plays(a.running.id)).toHaveLength(1);
		// A full log (rating, notes…) right after is its own entry, not a duplicate
		const full = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			pick,
			{ date: today, rating: 80 },
			today
		);
		expect(full.duplicate).toBe(false);
		expect(getItemDetail(a.user.id, a.running.id).logs.map((l) => l.rating)).toContain(80);
	});

	it('asks TMDB again before refusing an episode added since the list was saved', async () => {
		const a = account();
		await episodes.seasonEpisodes(String(a.id), 2, today);
		added = { episode_number: 5, air_date: '2026-10-28', name: 'Bonus round' };
		const r = await episodes.watchEpisode(a.user.id, a.running.id, { season: 2, episode: 5 }, null, today);
		expect(r.title).toBe('Bonus round');
	});

	it('keeps a running show’s episode lists for hours, a finished show’s for a month', async () => {
		const a = account();
		await episodes.seasonEpisodes(String(a.id), 1, today);
		await episodes.seasonEpisodes(String(a.id + 1), 1, today);
		const ttl = (key: string) =>
			(
				rawDb().prepare('SELECT expires_at FROM provider_cache WHERE key = ?').get(key) as {
					expires_at: number;
				}
			).expires_at - Date.now();
		expect(ttl(`tmdb:tv-season:${a.id}:1`)).toBeLessThan(13 * 3_600_000);
		expect(ttl(`tmdb:tv-season:${a.id + 1}:1`)).toBeGreaterThan(29 * 86_400_000);
	});

	it('counts an undated episode of an earlier season as out, like the progress does', async () => {
		const a = account();
		const s1 = await episodes.seasonEpisodes(String(a.id), 1, today);
		expect(s1.map((e) => [e.number, e.aired])).toEqual([
			[1, true],
			[2, true],
			[3, true]
		]);
		// …but one with a date still waits for it, Specials included
		const specials = await episodes.seasonEpisodes(String(a.id), 0, today);
		expect(specials.map((e) => [e.number, e.aired])).toEqual([
			[1, true],
			[2, false]
		]);
		expect((await episodes.markSeason(a.user.id, a.running.id, 0, null, today)).added).toBe(1);
	});

	it('goes ahead unnamed when TMDB is down while it re-checks an episode', async () => {
		const a = account();
		await episodes.seasonEpisodes(String(a.id), 1, today);
		const key = `tmdb:tv-season:${a.id}:1`;
		const expiry = () =>
			(
				rawDb().prepare('SELECT expires_at FROM provider_cache WHERE key = ?').get(key) as {
					expires_at: number;
				}
			).expires_at;
		const before = expiry();
		down = true;
		const r = await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 9 }, null, today);
		expect(r.title).toBeNull();
		expect(expiry()).toBe(before);
	});

	it('refuses episodes TMDB does not list, but not ones that have not aired', async () => {
		const a = account();
		await expect(
			episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 9 }, { date: today }, today)
		).rejects.toThrow(episodes.EpisodeError);
		await expect(
			episodes.watchEpisode(a.user.id, a.running.id, { season: 7, episode: 1 }, { date: today }, today)
		).rejects.toThrow(/no Season 7/);
		const early = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 2, episode: 3 },
			null,
			today
		);
		expect(early.logId).toBeNull();
	});

	it('goes ahead without a name when TMDB is down', async () => {
		const a = account();
		down = true;
		const r = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 2, episode: 1 },
			{ date: today },
			today
		);
		expect(r.title).toBeNull();
		expect(plays(a.running.id)).toHaveLength(1);
	});

	it('marks a show that has ended Completed at its last episode', async () => {
		const a = account('watching');
		await episodes.watchEpisode(a.user.id, a.ended.id, { season: 1, episode: 1 }, null, today);
		const last = await episodes.watchEpisode(
			a.user.id,
			a.ended.id,
			{ season: 1, episode: 2 },
			{ date: today },
			today
		);
		expect(last.status).toMatchObject({ key: 'completed', group: 'done', from: 'watching' });
		// A rewatch doesn't finish it again
		updateItem(a.user.id, a.ended.id, { status: 'watching' });
		const again = await episodes.watchEpisode(a.user.id, a.ended.id, { season: 1, episode: 1 }, null, today);
		expect(again.status).toBeNull();
		expect(statusOf(a.user.id, a.ended.id)).toBe('watching');
		// A running show stays Watching when caught up
		await episodes.markSeason(a.user.id, a.running.id, 1, null, today);
		await episodes.markSeason(a.user.id, a.running.id, 2, null, today);
		expect(statusOf(a.user.id, a.running.id)).toBe('watching');
	});

	it('reopens a finished show when a new episode is checked in', async () => {
		const a = account('completed');
		const r = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 2, episode: 1 },
			{ date: today },
			today
		);
		expect(r.status?.key).toBe('watching');
	});

	it('never touches another account’s show', async () => {
		const a = account();
		const b = account();
		await expect(
			episodes.watchEpisode(b.user.id, a.running.id, { season: 1, episode: 1 }, null, today)
		).rejects.toMatchObject({ status: 404 });
		const w = await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 1 }, null, today);
		await episodes.removePlay(b.user.id, w.watchId, a.running.id);
		await episodes.removePlay(a.user.id, w.watchId, a.ended.id); // not that show's play
		expect(plays(a.running.id)).toHaveLength(1);
		expect(episodes.unwatchEpisode(a.user.id, a.running.id, 1, 1).removed).toHaveLength(1);
		expect(() => episodes.unwatchEpisode(b.user.id, a.running.id, 1, 1)).toThrow();
	});
});

describe('marking several episodes', () => {
	it('marks a season’s aired episodes once, as one log when dated', async () => {
		const a = account();
		const r = await episodes.markSeason(a.user.id, a.running.id, 2, { date: '2026-10-15' }, today);
		expect(r.added).toBe(2); // E3 and E4 aren't out
		const again = await episodes.markSeason(a.user.id, a.running.id, 2, { date: '2026-10-15' }, today);
		expect(again).toMatchObject({ added: 0, logId: null });
		const detail = getItemDetail(a.user.id, a.running.id);
		expect(detail.logs.map((l) => logEpisodeLabel(l.episodes))).toEqual(['Season 2 · 2 episodes']);
		// Deleting the log un-watches the batch
		await deleteLog(a.user.id, r.logId!);
		expect(plays(a.running.id)).toEqual([]);
	});

	it('only adds episodes not watched yet', async () => {
		const a = account();
		await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 2 }, { date: today }, today);
		const r = await episodes.markRemaining(a.user.id, a.running.id, today);
		expect(r.added).toBe(4); // S1 E1, E3 and S2 E1, E2; never the special
		expect(plays(a.running.id)).toHaveLength(5);
	});

	it('unmarking a season keeps check-ins that have a log, and imported dates', async () => {
		const a = account();
		episodes.insertWatches(a.user.id, a.running.id, [{ season: 1, episode: 1, watchedAt: '2024-02-01' }]);
		await episodes.markSeason(a.user.id, a.running.id, 1, null, today);
		await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 3 }, { date: today }, today);
		expect(episodes.unmarkSeason(a.user.id, a.running.id, 1)).toEqual({ removed: 2, kept: 2 });
		expect(plays(a.running.id).map((p) => p.episode)).toEqual([1, 3]);
		// Unwatching an episode leaves an imported date too
		expect(episodes.unwatchEpisode(a.user.id, a.running.id, 1, 1)).toMatchObject({ removed: [], kept: 1 });
	});
});

describe('taking plays back', () => {
	it('unwatching keeps logged check-ins, and Undo puts the rest back', async () => {
		const a = account();
		await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 1 }, null, today);
		const logged = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{ date: '2026-10-01' },
			today
		);
		const r = episodes.unwatchEpisode(a.user.id, a.running.id, 1, 1);
		expect(r).toMatchObject({ removed: [{ title: 'Pilot 1', watchedAt: null }], kept: 1 });
		const before = episodes.watchedEpisodes(a.running.id, a.user.id);
		expect(plays(a.running.id)).toEqual([{ season: 1, episode: 1, logId: logged.logId }]);
		episodes.restorePlays(a.user.id, a.running.id, 1, 1, r.removed);
		expect(plays(a.running.id)).toHaveLength(2);
		// Back in its old place, so "next episode" is where it was
		expect(episodes.watchedEpisodes(a.running.id, a.user.id)[0].lastId).toBe(before[0].lastId);
		const ids = rawDb()
			.prepare('SELECT id FROM episode_watches WHERE item_id = ? ORDER BY id')
			.all(a.running.id);
		expect(ids).toContainEqual({ id: r.removed[0].id });
		// Undo sent twice puts it back once
		expect(episodes.restorePlays(a.user.id, a.running.id, 1, 1, r.removed)).toBe(0);
		expect(plays(a.running.id)).toHaveLength(2);
	});

	it('Undo never takes an id the table hasn’t handed out', async () => {
		const a = account();
		const huge = { id: Number.MAX_SAFE_INTEGER, title: null, watchedAt: null, createdAt: Date.now() + 1e12 };
		expect(episodes.restorePlays(a.user.id, a.running.id, 1, 1, [huge])).toBe(1);
		const row = rawDb()
			.prepare('SELECT id, created_at AS createdAt FROM episode_watches WHERE item_id = ?')
			.get(a.running.id) as { id: number; createdAt: number };
		expect(row.id).toBeLessThan(1_000_000);
		expect(row.createdAt).toBeLessThanOrEqual(Date.now());
		const next = await episodes.watchEpisode(a.user.id, a.ended.id, { season: 1, episode: 1 }, null, today);
		expect(next.watchId).toBe(row.id + 1);
	});

	it('removing a check-in removes its log; deleting a log removes its episode', async () => {
		const a = account();
		const c = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{ date: today },
			today
		);
		await episodes.removePlay(a.user.id, c.watchId, a.running.id);
		expect(getItemDetail(a.user.id, a.running.id).logs).toEqual([]);
		expect(getItem(a.user.id, a.running.id).lastLoggedAt).toBeNull();

		const d = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 2 },
			{ date: today },
			today
		);
		await deleteLog(a.user.id, d.logId!);
		expect(plays(a.running.id)).toEqual([]);
	});
});

describe('which episode a log is for', () => {
	it('can be changed or removed when editing the log', async () => {
		const a = account();
		const c = await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 1, episode: 1 },
			{ date: today },
			today
		);
		const show = episodes.trackedShow(a.user.id, a.running.id);
		const ep = await episodes.episodeForLog(show, { season: 2, episode: 1 });
		episodes.setLogEpisode(a.user.id, a.running.id, c.logId!, ep);
		expect(episodes.logPlays(c.logId!)).toEqual([{ season: 2, episode: 1, title: 'Back' }]);
		episodes.setLogEpisode(a.user.id, a.running.id, c.logId!, null);
		expect(episodes.logPlays(c.logId!)).toEqual([]);
		// A plain log can get an episode afterwards
		const plain = addLog(a.user.id, a.running.id, { date: today }, a.tv.statuses);
		episodes.setLogEpisode(a.user.id, a.running.id, plain.id, { season: 1, episode: 3, title: null });
		expect(episodes.logPlays(plain.id)).toHaveLength(1);
	});

	it('labels the Journal and recent activity', async () => {
		const a = account();
		await episodes.watchEpisode(a.user.id, a.running.id, { season: 1, episode: 3 }, { date: today }, today);
		const j = journal(a.user.id, { key: 'custom', from: '2026-10-01', to: today }, today, null, 50);
		expect(j.entries.map((e) => e.episode)).toEqual(['S1 E3 · Pilot 3']);
		expect(recentActivity(a.user.id)[0].ep).toContain('Pilot 3');
	});
});

describe('progress typed in before check-ins', () => {
	it('marks every aired episode up to it once, and then forgets it', async () => {
		const a = account('watching');
		const legacy = a.show(a.id + 2, 'Legacy', { current_season: 2, current_episode: 1 });
		const before = getItem(a.user.id, legacy.id).updatedAt;
		expect(await episodes.applySavedProgressNow(a.user.id, legacy.id, today)).toBe('applied');
		expect(plays(legacy.id).map((p) => `${p.season}:${p.episode}`)).toEqual(['1:1', '1:2', '1:3', '2:1']);
		const after = getItem(a.user.id, legacy.id);
		expect(after.custom).toEqual({});
		expect(after.updatedAt).toEqual(before);
		// Un-watching everything doesn't bring it back
		episodes.unmarkSeason(a.user.id, legacy.id, 1);
		episodes.unmarkSeason(a.user.id, legacy.id, 2);
		expect(await episodes.applySavedProgressNow(a.user.id, legacy.id, today)).toBe('none');
		expect(plays(legacy.id)).toEqual([]);
	});

	it('runs once even when two page loads race', async () => {
		const a = account('watching');
		const legacy = a.show(a.id + 2, 'Racy', { current_season: 1, current_episode: 3 });
		await Promise.all([
			episodes.applySavedProgressNow(a.user.id, legacy.id, today),
			episodes.applySavedProgressNow(a.user.id, legacy.id, today)
		]);
		expect(plays(legacy.id)).toHaveLength(3);
	});

	it('limits the episode to the season, and keeps progress TMDB has no season for', async () => {
		const a = account('watching');
		const big = a.show(a.id + 2, 'Big', { current_season: 1, current_episode: 78 });
		await episodes.applySavedProgressNow(a.user.id, big.id, today);
		expect(plays(big.id)).toHaveLength(3);
		const wild = a.show(a.id + 3, 'Wild', { current_season: 35, current_episode: 78 });
		expect(await episodes.applySavedProgressNow(a.user.id, wild.id, today)).toBe('unmatched');
		expect(plays(wild.id)).toEqual([]);
		const view = await episodes.loadTracker(a.user.id, episodes.trackedShow(a.user.id, wild.id), today);
		expect(view).toMatchObject({ ok: true, unmatchedProgress: 'S35 E78' });
	});

	it('shows the furthest episode watched on cards', async () => {
		const a = account('watching');
		await episodes.markSeason(a.user.id, a.running.id, 1, null, today);
		await episodes.watchEpisode(a.user.id, a.running.id, { season: 0, episode: 1 }, null, today);
		const { rows } = listItems(a.user.id, a.tv.id, a.tv.statuses, {});
		expect(rows.find((r) => r.id === a.running.id)?.custom).toMatchObject({
			current_season: 1,
			current_episode: 3
		});
	});
});

describe('the item page tracker', () => {
	it('shows progress and the next episode with its name', async () => {
		const a = account('watching');
		await episodes.markSeason(a.user.id, a.running.id, 1, null, today);
		const view = await episodes.loadTracker(a.user.id, episodes.trackedShow(a.user.id, a.running.id), today);
		expect(view).toMatchObject({
			ok: true,
			watched: 3,
			aired: 5,
			next: { season: 2, episode: 1, title: 'Back', airDate: '2026-10-07' },
			nextAiring: { season: 2, episode: 3 }
		});
	});

	it('still answers from saved TMDB data when TMDB is down, and says so when there is none', async () => {
		const a = account('watching');
		await episodes.markSeason(a.user.id, a.running.id, 1, null, today);
		// Expire everything saved, then take TMDB away
		rawDb().prepare('UPDATE provider_cache SET expires_at = 0').run();
		down = true;
		const stale = await episodes.loadTracker(a.user.id, episodes.trackedShow(a.user.id, a.running.id), today);
		expect(stale).toMatchObject({ ok: true, watched: 3 });

		const never = a.show(a.id + 6, 'Never seen');
		episodes.insertWatches(a.user.id, never.id, [{ season: 1, episode: 1 }]);
		const view = await episodes.loadTracker(a.user.id, episodes.trackedShow(a.user.id, never.id), today);
		expect(view).toMatchObject({ ok: false, watched: 1, seasons: [{ number: 1, watched: 1 }] });
		const season = await episodes.seasonView(a.user.id, never.id, 1, today);
		expect(season).toMatchObject({ ok: false, unlisted: [{ number: 1 }] });
	});

	it('keeps only what it needs of TMDB’s season answers', async () => {
		const a = account();
		await episodes.seasonEpisodes(String(a.id), 1, today);
		const row = rawDb()
			.prepare('SELECT value FROM provider_cache WHERE key = ?')
			.get(`tmdb:tv-season:${a.id}:1`) as { value: string };
		expect(row.value).not.toContain('lots of data');
		expect(JSON.parse(row.value).episodes[0]).toMatchObject({ id: 1001, episode_number: 1, name: 'Pilot 1' });
	});

	it('lists a season with each episode’s plays', async () => {
		const a = account();
		await episodes.watchEpisode(
			a.user.id,
			a.running.id,
			{ season: 2, episode: 1 },
			{ date: '2026-10-08' },
			today
		);
		const v = await episodes.seasonView(a.user.id, a.running.id, 2, today);
		expect(v.ok).toBe(true);
		expect(v.episodes.map((e) => [e.number, e.aired, e.plays.map((p) => p.date)])).toEqual([
			[1, true, ['2026-10-08']],
			[2, true, []],
			[3, false, []],
			[4, false, []]
		]);
	});
});

describe('the response cache', () => {
	it('serves an expired answer when the source is down, but not when it says "not found"', async () => {
		let fail: Error | null = null;
		const fn = async () => {
			if (fail) throw fail;
			return { v: 1 };
		};
		await cached('test:stale', 1, fn, { staleIfError: true });
		rawDb().prepare("UPDATE provider_cache SET expires_at = 0 WHERE key = 'test:stale'").run();
		fail = new ProviderError('down', 502, 'unreachable');
		expect(await cached('test:stale', 1, fn, { staleIfError: true })).toEqual({ v: 1 });
		rawDb().prepare("UPDATE provider_cache SET expires_at = 0 WHERE key = 'test:stale'").run();
		await expect(cached('test:stale', 1, fn)).rejects.toThrow('down');
		fail = new ProviderError('gone', 404, 'notfound');
		await expect(cached('test:stale', 1, fn, { staleIfError: true })).rejects.toThrow('gone');
	});
});

describe('Yamtrack import', () => {
	const header =
		'media_id,source,media_type,title,image,season_number,episode_number,score,progress,status,start_date,end_date,notes,created_at,progressed_at';

	it('imports each episode watched with its date, once', () => {
		const a = account();
		const csv = [
			header,
			`${a.id + 8},tmdb,tv,Imported,,,,8,3,In progress,2025-01-01,,,2025-01-01,2025-01-01`,
			`${a.id + 8},tmdb,episode,Imported,,1,1,,,,,2025-01-02,,2025-01-02,`,
			`${a.id + 8},tmdb,episode,Imported,,1,2,,,,,2025-01-03,,2025-01-03,`,
			`${a.id + 8},tmdb,episode,Imported,,1,1,,,,,2025-06-01,,2025-06-01,`
		].join('\n');
		const first = applyYamtrackImport(a.user.id, planYamtrackImport(csv));
		expect(first.episodesAdded).toBe(3); // the rewatch of E1 too
		const item = db()
			.select()
			.from(schema.items)
			.all()
			.find((i) => i.userId === a.user.id && i.providerId === String(a.id + 8))!;
		expect(item.custom).toEqual({});
		expect(applyYamtrackImport(a.user.id, planYamtrackImport(csv)).episodesAdded).toBe(0);
		expect(
			rawDb()
				.prepare('SELECT season, episode, watched_at AS d FROM episode_watches WHERE item_id = ? ORDER BY id')
				.all(item.id)
		).toEqual([
			{ season: 1, episode: 1, d: '2025-01-02' },
			{ season: 1, episode: 2, d: '2025-01-03' },
			{ season: 1, episode: 1, d: '2025-06-01' }
		]);
	});
});
