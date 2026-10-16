import { describe, expect, it } from 'vitest';
import {
	boundarySeason,
	buildGuide,
	computeTracker,
	logEpisodeLabel,
	parseLogEpisodes,
	progressLabel,
	type TmdbShow,
	type WatchedEpisode
} from './episodes';

const today = '2026-10-16';

/** Running show: season 1 aired in full, season 2 half-way, season 3 announced */
const running: TmdbShow = {
	status: 'Returning Series',
	first_air_date: '2024-01-01',
	last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2026-10-14' },
	next_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2026-10-21' },
	seasons: [
		{ season_number: 0, episode_count: 2, air_date: '2024-05-01' },
		{ season_number: 1, episode_count: 3, air_date: '2024-01-01' },
		{ season_number: 2, episode_count: 4, air_date: '2026-10-07' },
		{ season_number: 3, episode_count: 0, air_date: null }
	]
};
const season2 = {
	season_number: 2,
	episodes: [
		{ episode_number: 1, air_date: '2026-10-07', name: 'One' },
		{ episode_number: 2, air_date: '2026-10-14', name: 'Two' },
		{ episode_number: 3, air_date: '2026-10-21', name: 'Three' },
		{ episode_number: 4, air_date: null, name: 'TBA' }
	]
};

const w = (season: number, episode: number, lastId: number, plays = 1): WatchedEpisode => ({
	season,
	episode,
	plays,
	lastId
});

describe('which episodes are out', () => {
	it('counts earlier seasons in full and the current one up to today', () => {
		const g = buildGuide(running, season2, today);
		expect(g.seasons.map((s) => [s.number, s.aired, s.episodeCount])).toEqual([
			[1, [1, 2, 3], 3],
			[2, [1, 2], 4],
			[0, [1, 2], 2]
		]);
		expect(g.lastAired).toEqual({ season: 2, episode: 2 });
		expect(g.nextAiring).toEqual({ season: 2, episode: 3, airDate: '2026-10-21' });
	});

	it('goes by its own dates, not a stale "last episode" (an episode out today counts)', () => {
		const stale = { ...running, last_episode_to_air: { season_number: 2, episode_number: 1 } };
		const g = buildGuide(stale, season2, '2026-10-21');
		expect(g.seasons.find((s) => s.number === 2)?.aired).toEqual([1, 2, 3]);
	});

	it('ignores specials when finding the current season', () => {
		const specialLast = { ...running, last_episode_to_air: { season_number: 0, episode_number: 2 } };
		expect(boundarySeason(specialLast, today)).toBe(2);
	});

	it('without the season list, trusts the last aired episode', () => {
		const g = buildGuide(running, null, today);
		expect(g.seasons.find((s) => s.number === 2)?.aired).toEqual([1, 2]);
	});

	it('treats every episode of an old show without dates as out', () => {
		const old: TmdbShow = {
			status: 'Ended',
			last_episode_to_air: null,
			seasons: [
				{ season_number: 1, episode_count: 13 },
				{ season_number: 2, episode_count: 0 }
			]
		};
		const g = buildGuide(old, null, today);
		expect(g.seasons.map((s) => [s.number, s.aired.length])).toEqual([[1, 13]]);
		expect(g.ended).toBe(true);
	});

	it('has nothing out for a show that has not started', () => {
		const soon: TmdbShow = {
			status: 'In Production',
			first_air_date: '2027-01-01',
			seasons: [{ season_number: 1, episode_count: 8, air_date: '2027-01-01' }]
		};
		expect(buildGuide(soon, null, today).seasons[0].aired).toEqual([]);
	});

	it('counts undated episodes of an ended show', () => {
		const ended = { ...running, status: 'Ended' };
		expect(buildGuide(ended, season2, today).seasons.find((s) => s.number === 2)?.aired).toEqual([1, 2, 4]);
	});
});

describe('progress and the next episode', () => {
	const guide = buildGuide(running, season2, today);

	it('starts at the first episode', () => {
		const t = computeTracker(guide, []);
		expect(t.next).toEqual({ season: 1, episode: 1, watchedBefore: false });
		expect([t.watched, t.aired]).toEqual([0, 5]);
	});

	it('follows the episode marked last, skipping ones already seen', () => {
		const t = computeTracker(guide, [w(1, 1, 1), w(1, 3, 2), w(1, 2, 3)]);
		expect(t.next).toEqual({ season: 2, episode: 1, watchedBefore: false });
		expect(t.seasons.find((s) => s.number === 1)).toMatchObject({ aired: 3, watched: 3 });
	});

	it('is up to date after the last aired episode (specials do not count)', () => {
		const rows = [w(1, 1, 1), w(1, 2, 2), w(1, 3, 3), w(2, 1, 4), w(2, 2, 5)];
		const t = computeTracker(guide, rows);
		expect(t.next).toBeNull();
		expect(t.allWatched).toBe(true);
		expect(t.ended).toBe(false);
	});

	it('offers the following episode during a rewatch', () => {
		const rows = [w(1, 1, 6, 2), w(1, 2, 2), w(1, 3, 3), w(2, 1, 4), w(2, 2, 5)];
		expect(computeTracker(guide, rows).next).toEqual({ season: 1, episode: 2, watchedBefore: true });
	});

	it('goes back to an episode that was skipped', () => {
		expect(computeTracker(guide, [w(2, 2, 1)]).next).toEqual({ season: 1, episode: 1, watchedBefore: false });
	});

	it('never counts more than what is out, and lists episodes TMDB dropped', () => {
		const t = computeTracker(guide, [w(1, 1, 1), w(1, 1, 2), w(2, 3, 3), w(1, 9, 4), w(7, 1, 5)]);
		expect([t.watched, t.aired]).toEqual([1, 5]);
		expect(t.unmatched).toEqual([
			{ season: 1, episode: 9, plays: 1 },
			{ season: 7, episode: 1, plays: 1 }
		]);
	});
});

describe('labels', () => {
	it('names the episodes on a log', () => {
		expect(logEpisodeLabel(parseLogEpisodes('[1, 200005, 200005, "The One"]'))).toBe('S2 E5 · The One');
		expect(logEpisodeLabel(parseLogEpisodes('[10, 200001, 200010, null]'))).toBe('Season 2 · 10 episodes');
		expect(logEpisodeLabel(parseLogEpisodes('[3, 100009, 200001, "x"]'))).toBe('S1 E9 – S2 E1 · 3 episodes');
		expect(logEpisodeLabel(parseLogEpisodes('[1, 3, 3, null]'))).toBe('Special 3');
		expect(parseLogEpisodes('[0, null, null, null]')).toBeNull();
		expect(parseLogEpisodes('nonsense')).toBeNull();
	});

	it('shows progress as S3 E5', () => {
		expect(progressLabel({ current_season: 3, current_episode: 5 })).toBe('S3 E5');
		expect(progressLabel({ current_season: 2 })).toBe('Season 2');
		expect(progressLabel({ current_season: '' })).toBeNull();
		expect(progressLabel({})).toBeNull();
	});
});
