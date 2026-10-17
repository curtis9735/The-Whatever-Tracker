// Episode tracking for shows linked to TMDB: what has aired, what's been watched and what's next.

/** TMDB's answers, trimmed to what the app keeps (see providers/tmdb.ts) */
export interface TmdbEpisode {
	id?: number;
	air_date?: string | null;
	season_number?: number;
	episode_number?: number;
	name?: string;
	runtime?: number | null;
}

export interface TmdbShowSeason {
	season_number: number;
	episode_count?: number;
	air_date?: string | null;
	name?: string;
}

export interface TmdbShow {
	status?: string;
	first_air_date?: string | null;
	last_episode_to_air?: TmdbEpisode | null;
	next_episode_to_air?: TmdbEpisode | null;
	seasons?: TmdbShowSeason[];
}

export interface TmdbSeason {
	season_number?: number;
	name?: string;
	episodes?: TmdbEpisode[];
}

/**
 * The TV Shows list's typed-in progress fields. Shows linked to TMDB track progress with check-ins
 * instead; a value still stored there is only used once, to mark the episodes up to it as watched.
 */
export const PROGRESS_KEYS = ['current_season', 'current_episode'];

export const MAX_EPISODE_NUMBER = 9999;

/** Season 0 is Specials; episodes are numbered from 1 */
export function validEpisode(season: number, episode: number) {
	return (
		Number.isInteger(season) &&
		Number.isInteger(episode) &&
		season >= 0 &&
		season <= MAX_EPISODE_NUMBER &&
		episode >= 1 &&
		episode <= MAX_EPISODE_NUMBER
	);
}

export function isTrackedShow(item: {
	provider: string | null;
	providerKind: string | null;
	providerId: string | null;
}) {
	return item.provider === 'tmdb' && item.providerKind === 'tv' && /^\d+$/.test(item.providerId ?? '');
}

/**
 * Whether an item's "Current season / episode" fields are its owner's own progress: on a show, or on a
 * list of shows. Only the owner sets them, and people the list is shared with don't see them.
 */
export function ownersProgressFields(
	item: { provider?: string | null; providerKind?: string | null } | null,
	listKinds: string[]
) {
	return (item?.provider === 'tmdb' && item.providerKind === 'tv') || listKinds.includes('tmdb:tv');
}

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const isEnded = (status: string | null | undefined) => /ended|canceled/i.test(status ?? '');

/** Whether an episode is out by `today`. Undated episodes count only once the show has ended. */
export function hasAired(airDate: string | null | undefined, today: string, ended: boolean) {
	return isDate(airDate) ? airDate <= today : ended;
}

export function episodeCode(season: number, episode: number) {
	return season === 0 ? `Special ${episode}` : `S${season} E${episode}`;
}

export function seasonLabel(season: number) {
	return season === 0 ? 'Specials' : `Season ${season}`;
}

export interface GuideSeason {
	number: number;
	/** Episodes TMDB lists, aired or not */
	episodeCount: number;
	airDate: string | null;
	/** Numbers of the episodes that are out */
	aired: number[];
}

export interface EpisodeGuide {
	ended: boolean;
	/** Regular seasons in order, then Specials */
	seasons: GuideSeason[];
	lastAired: { season: number; episode: number } | null;
	nextAiring: { season: number; episode: number; airDate: string } | null;
}

/**
 * The season of the newest aired episode. Its episode list says which of its episodes are out;
 * every season before it has aired in full.
 */
export function boundarySeason(show: TmdbShow, today: string): number | null {
	let best: number | null = null;
	for (const s of show.seasons ?? []) {
		if (s.season_number > 0 && (s.episode_count ?? 0) > 0 && isDate(s.air_date) && s.air_date <= today) {
			best = Math.max(best ?? 0, s.season_number);
		}
	}
	const last = show.last_episode_to_air?.season_number ?? 0;
	return last > 0 && last > (best ?? 0) ? last : best;
}

const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);

/** Which episodes are out, from the show and (when it loaded) the episode list of its boundary season. */
export function buildGuide(show: TmdbShow, boundary: TmdbSeason | null, today: string): EpisodeGuide {
	const ended = isEnded(show.status);
	const b = boundarySeason(show, today);
	const listed = (show.seasons ?? []).filter(
		(s) =>
			Number.isInteger(s.season_number) &&
			s.season_number >= 0 &&
			((s.episode_count ?? 0) > 0 || s.season_number === b)
	);
	const ordered = [
		...listed.filter((s) => s.season_number > 0).sort((x, y) => x.season_number - y.season_number),
		...listed.filter((s) => s.season_number === 0)
	];
	// No dates at all (common for old shows): everything TMDB lists has aired
	const undated =
		b === null &&
		(ended ||
			(show.first_air_date
				? show.first_air_date <= today
				: !/planned|production|pilot/i.test(show.status ?? '')));
	const boundaryEpisodes = (boundary?.episodes ?? []).filter((e) => typeof e.episode_number === 'number');

	const seasons = ordered.map((s): GuideSeason => {
		const n = s.season_number;
		const count = s.episode_count ?? 0;
		let aired: number[];
		if (n === 0 || undated || (b !== null && n < b)) aired = range(count);
		else if (n === b) {
			if (boundaryEpisodes.length) {
				aired = boundaryEpisodes
					.filter((e) => hasAired(e.air_date, today, ended))
					.map((e) => e.episode_number!);
			} else {
				const last = show.last_episode_to_air;
				aired = range(last?.season_number === n && last.episode_number ? last.episode_number : count);
			}
		} else aired = [];
		aired = [...new Set(aired)].sort((x, y) => x - y);
		return {
			number: n,
			episodeCount: Math.max(count, aired.at(-1) ?? 0, n === b ? boundaryEpisodes.length : 0),
			airDate: s.air_date ?? null,
			aired
		};
	});

	const lastSeason = seasons.filter((s) => s.number > 0 && s.aired.length).at(-1);
	const upcoming =
		boundaryEpisodes.find((e) => isDate(e.air_date) && e.air_date > today) ??
		[show.next_episode_to_air].find(
			(e) => e && (e.season_number ?? 0) > 0 && isDate(e.air_date) && e.air_date > today
		);
	return {
		ended,
		seasons,
		lastAired: lastSeason ? { season: lastSeason.number, episode: lastSeason.aired.at(-1)! } : null,
		nextAiring:
			upcoming && typeof upcoming.episode_number === 'number'
				? {
						season: upcoming.season_number ?? b ?? 0,
						episode: upcoming.episode_number,
						airDate: upcoming.air_date as string
					}
				: null
	};
}

/** Plays of one episode: how many, and the newest one's row id (rows are numbered in the order they were added) */
export interface WatchedEpisode {
	season: number;
	episode: number;
	plays: number;
	lastId: number;
}

export interface TrackerSeason {
	number: number;
	episodeCount: number;
	airDate: string | null;
	aired: number;
	watched: number;
}

export interface Tracker {
	ended: boolean;
	seasons: TrackerSeason[];
	/** Regular episodes out so far, and how many of them were watched (Specials don't count) */
	aired: number;
	watched: number;
	allWatched: boolean;
	next: { season: number; episode: number; watchedBefore: boolean } | null;
	nextAiring: EpisodeGuide['nextAiring'];
	lastAired: EpisodeGuide['lastAired'];
	/** Watched episodes TMDB no longer lists (renumbered or removed) */
	unmatched: { season: number; episode: number; plays: number }[];
}

const key = (season: number, episode: number) => `${season}:${episode}`;

export function computeTracker(guide: EpisodeGuide, rows: WatchedEpisode[]): Tracker {
	const watched = new Map(rows.map((r) => [key(r.season, r.episode), r]));
	const seen = (o: { season: number; episode: number }) => watched.has(key(o.season, o.episode));
	const order = guide.seasons
		.filter((s) => s.number > 0)
		.flatMap((s) => s.aired.map((episode) => ({ season: s.number, episode })));

	const seasons = guide.seasons.map((s) => ({
		number: s.number,
		episodeCount: s.episodeCount,
		airDate: s.airDate,
		aired: s.aired.length,
		watched: s.aired.filter((e) => watched.has(key(s.number, e))).length
	}));
	const regular = seasons.filter((s) => s.number > 0);
	const aired = regular.reduce((n, s) => n + s.aired, 0);
	const watchedCount = regular.reduce((n, s) => n + s.watched, 0);

	// Pick up after the episode marked most recently: the next one not seen yet, or simply the
	// following one when everything after it was seen (a rewatch), else the first one missed
	const last = rows.filter((r) => r.season > 0).sort((x, y) => y.lastId - x.lastId)[0];
	let next: { season: number; episode: number } | null;
	if (!last) next = order[0] ?? null;
	else {
		const after = order.filter(
			(o) => o.season > last.season || (o.season === last.season && o.episode > last.episode)
		);
		next = after.find((o) => !seen(o)) ?? after[0] ?? order.find((o) => !seen(o)) ?? null;
	}

	const bySeason = new Map(guide.seasons.map((s) => [s.number, s]));
	return {
		ended: guide.ended,
		seasons,
		aired,
		watched: watchedCount,
		allWatched: aired > 0 && watchedCount === aired,
		next: next ? { ...next, watchedBefore: seen(next) } : null,
		nextAiring: guide.nextAiring,
		lastAired: guide.lastAired,
		unmatched: rows
			.filter((r) => {
				const s = bySeason.get(r.season);
				return !s || r.episode > s.episodeCount;
			})
			.map((r) => ({ season: r.season, episode: r.episode, plays: r.plays }))
	};
}

/** What the item page shows: the tracker, or (TMDB unreachable) what is known without it */
export type TrackerView =
	| (Omit<Tracker, 'next'> & {
			ok: true;
			next: (NonNullable<Tracker['next']> & { title: string | null; airDate: string | null }) | null;
			/** Saved progress TMDB has no season for, e.g. "S35 E78" */
			unmatchedProgress: string | null;
	  })
	| {
			ok: false;
			error: string;
			/** What's known without TMDB: episodes watched per season */
			seasons: { number: number; watched: number }[];
			watched: number;
	  };

/** Episodes a log is for, as stored: the count, the first and last (season × 100000 + episode) and a title */
export interface LogEpisodes {
	count: number;
	first: { season: number; episode: number };
	last: { season: number; episode: number };
	title: string | null;
}

export const EPISODE_ORDER = 100_000;

/** Reads `[count, first, last, title]` as returned by the log-episodes SQL (see services/episodes.ts). */
export function parseLogEpisodes(raw: string | null | undefined): LogEpisodes | null {
	if (!raw) return null;
	try {
		const [count, first, last, title] = JSON.parse(raw) as [
			number,
			number | null,
			number | null,
			string | null
		];
		if (!count || first === null || last === null) return null;
		const split = (n: number) => ({ season: Math.floor(n / EPISODE_ORDER), episode: n % EPISODE_ORDER });
		return { count, first: split(first), last: split(last), title: count === 1 ? title : null };
	} catch {
		return null;
	}
}

/** "S2 E5 · Title", "Season 2 · 10 episodes" or "S1 E9 – S2 E2 · 4 episodes" */
export function logEpisodeLabel(e: LogEpisodes | null): string | null {
	if (!e) return null;
	if (e.count === 1)
		return `${episodeCode(e.first.season, e.first.episode)}${e.title ? ` · ${e.title}` : ''}`;
	if (e.first.season === e.last.season) return `${seasonLabel(e.first.season)} · ${e.count} episodes`;
	return `${episodeCode(e.first.season, e.first.episode)} – ${episodeCode(e.last.season, e.last.episode)} · ${e.count} episodes`;
}

/** "S3 E5" for the progress fields on cards, or null when the item has none */
export function progressLabel(custom: Record<string, unknown>): string | null {
	const s = Number(custom.current_season);
	const e = Number(custom.current_episode);
	if (!Number.isInteger(s) || s <= 0) return null;
	return Number.isInteger(e) && e > 0 ? `S${s} E${e}` : `Season ${s}`;
}
