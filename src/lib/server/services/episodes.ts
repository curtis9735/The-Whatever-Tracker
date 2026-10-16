import { error } from '@sveltejs/kit';
import { rawDb } from '../db';
import { tmdbSeason, tmdbTvShow } from '../providers/tmdb';
import { ProviderError } from '../providers/util';
import { getCategoryById } from './categories';
import { addLog, deleteLog, getOwnedItem, type LogInput, updateItem } from './items';
import {
	boundarySeason,
	buildGuide,
	computeTracker,
	episodeCode,
	isDate,
	isTrackedShow,
	progressLabel,
	seasonLabel,
	validEpisode,
	type EpisodeGuide,
	type TmdbSeason,
	type Tracker,
	type TrackerView,
	type WatchedEpisode
} from '$lib/episodes';
import type { Item } from '../db/schema';
import type { StatusDef } from '$lib/types';

/** Something wrong with what was asked for (shown as is), as opposed to TMDB being unreachable */
export class EpisodeError extends Error {}

type Show = Item & { providerId: string };

export function trackedShow(userId: number, itemId: number): Show {
	const item = getOwnedItem(userId, itemId);
	if (!isTrackedShow(item)) error(400, 'Episodes are tracked for shows linked to TMDB');
	return item as Show;
}

export function tmdbProblem(e: unknown) {
	if (e instanceof ProviderError) return e.message;
	return (e as Error)?.name === 'TimeoutError' ? 'TMDB took too long to answer' : 'TMDB could not be reached';
}

// --- What TMDB lists ------------------------------------------------------------------------

/** Which episodes of a show are out by `today` */
export async function episodeGuide(tmdbId: string, today: string): Promise<EpisodeGuide> {
	const show = await tmdbTvShow(tmdbId);
	const b = boundarySeason(show, today);
	// Without the boundary season's own list, its episodes are judged from the show's summary
	const boundary = b === null ? null : await tmdbSeason(tmdbId, b).catch(() => null);
	return buildGuide(show, boundary, today);
}

export interface SeasonEpisode {
	number: number;
	name: string | null;
	airDate: string | null;
	aired: boolean;
	runtime: number | null;
}

/**
 * A season's episodes in order. TMDB answering 404 means it has no such season. An episode with a
 * date is out once that day comes; one without follows the progress count (episodeGuide), where
 * earlier seasons count in full.
 */
export async function seasonEpisodes(
	tmdbId: string,
	season: number,
	today: string
): Promise<SeasonEpisode[]> {
	const s = await tmdbSeason(tmdbId, season);
	const guide = await episodeGuide(tmdbId, today).catch(() => null);
	const out = new Set(guide?.seasons.find((g) => g.number === season)?.aired ?? []);
	const ended = guide?.ended ?? false;
	const seen = new Set<number>();
	return (s.episodes ?? [])
		.filter(
			(e) => typeof e.episode_number === 'number' && !seen.has(e.episode_number) && seen.add(e.episode_number)
		)
		.sort((a, b) => a.episode_number! - b.episode_number!)
		.map((e) => ({
			number: e.episode_number!,
			name: e.name?.trim() || null,
			airDate: e.air_date ?? null,
			aired: isDate(e.air_date) ? e.air_date <= today : out.has(e.episode_number!) || ended,
			runtime: e.runtime ?? null
		}));
}

/** The episode's name. Episodes TMDB doesn't list are refused; when TMDB can't be reached, it goes ahead unnamed. */
async function episodeTitle(tmdbId: string, season: number, episode: number): Promise<string | null> {
	const find = (list: TmdbSeason) => (list.episodes ?? []).find((x) => x.episode_number === episode);
	let ep;
	try {
		ep = find(await tmdbSeason(tmdbId, season));
		// Added since the list was saved? Ask TMDB again before refusing
		if (!ep) ep = find(await tmdbSeason(tmdbId, season, undefined, { fresh: true }));
	} catch (e) {
		if (e instanceof ProviderError && e.code === 'notfound') {
			throw new EpisodeError(`TMDB has no ${seasonLabel(season)} for this show.`);
		}
		return null;
	}
	if (!ep)
		throw new EpisodeError(`${episodeCode(season, episode)} isn't in TMDB's episode list for this show.`);
	return ep.name?.trim() || null;
}

// --- Plays ------------------------------------------------------------------------------

/** Each episode watched, with its number of plays and the newest play's id */
export function watchedEpisodes(itemId: number): WatchedEpisode[] {
	return rawDb()
		.prepare(
			`SELECT season, episode, COUNT(*) AS plays, MAX(id) AS lastId FROM episode_watches
			 WHERE item_id = ? GROUP BY season, episode`
		)
		.all(itemId) as WatchedEpisode[];
}

export interface Play {
	id: number;
	logId: number | null;
	/** The log's date, the imported date, or null when it isn't known */
	date: string | null;
	/** Other episodes on the same log (a whole season marked at once) */
	shared: number;
}

/** Plays of a season's episodes, newest first, by episode number */
export function seasonPlays(itemId: number, season: number) {
	const rows = rawDb()
		.prepare(
			`SELECT w.id, w.episode, w.log_id AS logId, COALESCE(l.date, w.watched_at) AS date,
				(SELECT COUNT(*) - 1 FROM episode_watches o WHERE o.log_id = w.log_id) AS shared
			 FROM episode_watches w LEFT JOIN item_logs l ON l.id = w.log_id
			 WHERE w.item_id = ? AND w.season = ? ORDER BY w.id DESC`
		)
		.all(itemId, season) as (Play & { episode: number })[];
	const out = new Map<number, Play[]>();
	for (const { episode, ...p } of rows) {
		const list = out.get(episode) ?? [];
		list.push({ ...p, shared: p.logId ? p.shared : 0 });
		out.set(episode, list);
	}
	return out;
}

interface NewPlay {
	season: number;
	episode: number;
	title?: string | null;
	watchedAt?: string | null;
}

/**
 * Adds plays in one transaction: by default only for episodes not watched yet, so marking a season
 * twice (or a double click) changes nothing. Returns how many were added.
 */
export function insertWatches(
	userId: number,
	itemId: number,
	plays: NewPlay[],
	{ logId = null, onlyNew = true }: { logId?: number | null; onlyNew?: boolean } = {}
) {
	const sqlite = rawDb();
	const exists = sqlite.prepare(
		'SELECT 1 FROM episode_watches WHERE item_id = ? AND season = ? AND episode = ? LIMIT 1'
	);
	const insert = sqlite.prepare(
		`INSERT INTO episode_watches (user_id, item_id, log_id, season, episode, title, watched_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const now = Date.now();
	return sqlite.transaction(() => {
		let added = 0;
		for (const p of plays) {
			if (onlyNew && exists.get(itemId, p.season, p.episode)) continue;
			insert.run(userId, itemId, logId, p.season, p.episode, p.title ?? null, p.watchedAt ?? null, now);
			added++;
		}
		return added;
	})();
}

/** A check-in without a log still counts as activity on the show */
function touch(itemId: number) {
	rawDb().prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(Date.now(), itemId);
}

const episodeKey = (p: { season: number; episode: number }) => `${p.season}:${p.episode}`;

// --- Status -----------------------------------------------------------------------------

export interface StatusChange {
	key: string;
	label: string;
	group: string;
	/** The status before, so Undo can put it back */
	from: string | null;
}

/**
 * Keeps the show's status in step with its episodes: a check-in starts a planned show, a new
 * episode reopens a finished or dropped one, and the last episode of a show that has ended finishes it.
 */
async function settleStatus(
	userId: number,
	item: Show,
	statuses: StatusDef[],
	firstWatch: boolean,
	today: string
): Promise<StatusChange | null> {
	const current = getOwnedItem(userId, item.id).status;
	const group = statuses.find((s) => s.key === current)?.group;
	const active = statuses.find((s) => s.group === 'active')?.key;
	const done = statuses.find((s) => s.group === 'done')?.key;
	let tracker: Tracker | null = null;
	try {
		tracker = computeTracker(await episodeGuide(item.providerId, today), watchedEpisodes(item.id));
	} catch {
		/* TMDB is down: whether this finished the show isn't known */
	}
	let next: string | undefined;
	// Only a first watch can finish a show (a rewatch of one that's done leaves its status alone)
	if (firstWatch && tracker?.ended && tracker.allWatched && group !== 'done') next = done;
	else if (!current || group === 'planned') next = active ?? done;
	else if ((group === 'done' || group === 'dropped') && firstWatch && tracker && !tracker.allWatched)
		next = active;
	if (!next || next === current) return null;
	updateItem(userId, item.id, { status: next });
	const s = statuses.find((x) => x.key === next)!;
	return { key: s.key, label: s.label, group: s.group, from: current };
}

// --- Check-ins --------------------------------------------------------------------------

export interface WatchResult {
	watchId: number;
	logId: number | null;
	season: number;
	episode: number;
	title: string | null;
	/** The same check-in sent twice in a row (a double tap): nothing new was saved */
	duplicate: boolean;
	status: StatusChange | null;
}

const DOUBLE_TAP_MS = 60_000;

/**
 * Checks in one episode. With a log (date, rating, notes…) it shows up in the history and Journal;
 * without one it is simply marked watched ("don't remember when").
 */
export async function watchEpisode(
	userId: number,
	itemId: number,
	pick: { season: number; episode: number },
	log: LogInput | null,
	today: string,
	/** A one-tap check-in: a second tap within a minute is the same check-in */
	{ quick = false }: { quick?: boolean } = {}
): Promise<WatchResult> {
	const item = trackedShow(userId, itemId);
	if (!validEpisode(pick.season, pick.episode)) throw new EpisodeError('Pick a season and episode.');
	const title = await episodeTitle(item.providerId, pick.season, pick.episode);
	const { category } = getCategoryById(userId, item.categoryId);
	const sqlite = rawDb();

	// From here on nothing waits, so two taps can't both pass this check
	const prev = sqlite
		.prepare(
			`SELECT w.id, w.log_id AS logId, w.created_at AS createdAt, l.date FROM episode_watches w
			 LEFT JOIN item_logs l ON l.id = w.log_id
			 WHERE w.item_id = ? AND w.season = ? AND w.episode = ? ORDER BY w.id DESC LIMIT 1`
		)
		.get(item.id, pick.season, pick.episode) as
		{ id: number; logId: number | null; createdAt: number; date: string | null } | undefined;
	const base = { ...pick, title, status: null };
	if (quick && prev && Date.now() - prev.createdAt < DOUBLE_TAP_MS && prev.date === (log?.date ?? null)) {
		return { ...base, watchId: prev.id, logId: prev.logId, duplicate: true };
	}

	const insert = (logId: number | null) =>
		Number(
			sqlite
				.prepare(
					`INSERT INTO episode_watches (user_id, item_id, log_id, season, episode, title, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(userId, item.id, logId, pick.season, pick.episode, title, Date.now()).lastInsertRowid
		);
	let watchId = 0;
	let logId: number | null = null;
	if (log) {
		logId = addLog(userId, item.id, log, category.statuses, {
			promote: false,
			withLog: (id) => (watchId = insert(id))
		}).id;
	} else {
		watchId = insert(null);
		touch(item.id);
	}
	const status = await settleStatus(userId, item, category.statuses, !prev, today);
	return { ...base, watchId, logId, duplicate: false, status };
}

/**
 * Marks a season's aired episodes watched (only ones not watched yet). With a log, the whole batch
 * is one entry in the history ("Season 2 · 10 episodes"), and deleting it un-watches the batch.
 */
export async function markSeason(
	userId: number,
	itemId: number,
	season: number,
	log: LogInput | null,
	today: string
) {
	const item = trackedShow(userId, itemId);
	if (!validEpisode(season, 1)) throw new EpisodeError('Pick a season.');
	let plays: NewPlay[];
	try {
		plays = (await seasonEpisodes(item.providerId, season, today))
			.filter((e) => e.aired)
			.map((e) => ({ season, episode: e.number, title: e.name }));
	} catch (e) {
		if (e instanceof ProviderError && e.code === 'notfound') {
			throw new EpisodeError(`TMDB has no ${seasonLabel(season)} for this show.`);
		}
		// The season's own list didn't load: go by the show's summary
		const g = (await episodeGuide(item.providerId, today)).seasons.find((s) => s.number === season);
		plays = (g?.aired ?? []).map((episode) => ({ season, episode }));
	}
	if (!plays.length) throw new EpisodeError(`No episodes of ${seasonLabel(season)} are out yet.`);
	return markPlays(userId, item, plays, log, today);
}

/** Marks every aired episode not watched yet (e.g. after setting a show to Completed) */
export async function markRemaining(userId: number, itemId: number, today: string) {
	const item = trackedShow(userId, itemId);
	const guide = await episodeGuide(item.providerId, today);
	const plays = guide.seasons
		.filter((s) => s.number > 0)
		.flatMap((s) => s.aired.map((episode) => ({ season: s.number, episode })));
	return markPlays(userId, item, plays, null, today);
}

async function markPlays(userId: number, item: Show, plays: NewPlay[], log: LogInput | null, today: string) {
	const { category } = getCategoryById(userId, item.categoryId);
	const have = new Set(watchedEpisodes(item.id).map(episodeKey));
	const fresh = plays.filter((p) => !have.has(episodeKey(p)));
	if (!fresh.length) return { added: 0, logId: null, status: null };
	let added = 0;
	let logId: number | null = null;
	if (log) {
		logId = addLog(userId, item.id, log, category.statuses, {
			promote: false,
			withLog: (id) => (added = insertWatches(userId, item.id, fresh, { logId: id }))
		}).id;
	} else {
		added = insertWatches(userId, item.id, fresh);
		touch(item.id);
	}
	const status = await settleStatus(userId, item, category.statuses, added > 0, today);
	return { added, logId, status };
}

// --- Taking plays back ------------------------------------------------------------------

export interface UndatedPlay {
	/** The play's row id, so Undo puts it back in its place in the watch order */
	id: number | null;
	title: string | null;
	watchedAt: string | null;
	createdAt: number | null;
}

/**
 * Un-watches an episode's plays marked without a date. Check-ins with a log (they hold ratings,
 * notes and photos) and imported plays with a date are kept; those are removed one by one. Returns
 * what was removed, so it can be put back.
 */
/** Plays marked watched without saying when */
const UNDATED = 'log_id IS NULL AND watched_at IS NULL';

export function unwatchEpisode(userId: number, itemId: number, season: number, episode: number) {
	trackedShow(userId, itemId);
	const sqlite = rawDb();
	return sqlite.transaction(() => {
		const removed = sqlite
			.prepare(
				`SELECT id, title, watched_at AS watchedAt, created_at AS createdAt FROM episode_watches
				 WHERE item_id = ? AND season = ? AND episode = ? AND ${UNDATED}`
			)
			.all(itemId, season, episode) as UndatedPlay[];
		sqlite
			.prepare(`DELETE FROM episode_watches WHERE item_id = ? AND season = ? AND episode = ? AND ${UNDATED}`)
			.run(itemId, season, episode);
		const kept = (
			sqlite
				.prepare('SELECT COUNT(*) AS n FROM episode_watches WHERE item_id = ? AND season = ? AND episode = ?')
				.get(itemId, season, episode) as { n: number }
		).n;
		return { removed, kept };
	})();
}

/** Puts back plays taken away by unwatchEpisode (its Undo) */
export function restorePlays(
	userId: number,
	itemId: number,
	season: number,
	episode: number,
	plays: UndatedPlay[]
) {
	trackedShow(userId, itemId);
	if (!validEpisode(season, episode)) return 0;
	const sqlite = rawDb();
	const insert = sqlite.prepare(
		`INSERT INTO episode_watches (id, user_id, item_id, season, episode, title, watched_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const taken = sqlite.prepare('SELECT 1 FROM episode_watches WHERE id = ?');
	const now = Date.now();
	return sqlite.transaction(() => {
		// Ids come from the browser: only one handed out before may be reused, so the table's shared
		// id counter can never be pushed forward
		const seq =
			(
				sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'episode_watches'").get() as
					{ seq: number } | undefined
			)?.seq ?? 0;
		let restored = 0;
		for (const p of plays.slice(0, 50)) {
			// Already back (Undo sent twice)
			if (p.id && taken.get(p.id)) continue;
			const id = p.id && p.id <= seq ? p.id : null;
			const createdAt = p.createdAt && p.createdAt <= now ? p.createdAt : now;
			insert.run(id, userId, itemId, season, episode, p.title, p.watchedAt, createdAt);
			restored++;
		}
		return restored;
	})();
}

/** Un-watches a season's episodes marked without a date; check-ins with a log and imported dates stay. */
export function unmarkSeason(userId: number, itemId: number, season: number) {
	trackedShow(userId, itemId);
	const sqlite = rawDb();
	return sqlite.transaction(() => {
		const removed = sqlite
			.prepare(`DELETE FROM episode_watches WHERE item_id = ? AND season = ? AND ${UNDATED}`)
			.run(itemId, season).changes;
		const kept = (
			sqlite
				.prepare('SELECT COUNT(DISTINCT episode) AS n FROM episode_watches WHERE item_id = ? AND season = ?')
				.get(itemId, season) as { n: number }
		).n;
		return { removed, kept };
	})();
}

/**
 * Removes one play. A check-in goes with its log (and the log's photos); a log for several episodes
 * (a whole season) keeps the others. A play that is already gone (a second tap) is fine.
 */
export async function removePlay(userId: number, watchId: number, itemId: number) {
	const sqlite = rawDb();
	const w = sqlite
		.prepare('SELECT id, log_id AS logId FROM episode_watches WHERE id = ? AND user_id = ? AND item_id = ?')
		.get(watchId, userId, itemId) as { id: number; logId: number | null } | undefined;
	if (!w) return;
	const onLog = w.logId
		? (
				sqlite.prepare('SELECT COUNT(*) AS n FROM episode_watches WHERE log_id = ?').get(w.logId) as {
					n: number;
				}
			).n
		: 0;
	if (w.logId && onLog === 1) await deleteLog(userId, w.logId);
	else sqlite.prepare('DELETE FROM episode_watches WHERE id = ?').run(w.id);
}

// --- Which episode a log is for ---------------------------------------------------------

/** Checks a picked episode against TMDB and returns it with its name (see watchEpisode for the rules) */
export async function episodeForLog(item: Show, pick: { season: number; episode: number }) {
	if (!validEpisode(pick.season, pick.episode)) throw new EpisodeError('Pick a season and episode.');
	return { ...pick, title: await episodeTitle(item.providerId, pick.season, pick.episode) };
}

/**
 * Changes the episode a log is for (null: none). Runs inside the log's save. Logs for several
 * episodes at once (a whole season) are left as they are.
 */
export function setLogEpisode(
	userId: number,
	itemId: number,
	logId: number,
	ep: { season: number; episode: number; title: string | null } | null
) {
	const sqlite = rawDb();
	const rows = sqlite.prepare('SELECT id FROM episode_watches WHERE log_id = ?').all(logId) as {
		id: number;
	}[];
	if (rows.length > 1) return;
	if (!ep) sqlite.prepare('DELETE FROM episode_watches WHERE log_id = ?').run(logId);
	else if (rows.length) {
		sqlite
			.prepare('UPDATE episode_watches SET season = ?, episode = ?, title = ? WHERE id = ?')
			.run(ep.season, ep.episode, ep.title, rows[0].id);
	} else insertWatches(userId, itemId, [ep], { logId, onlyNew: false });
}

/** Episodes on one log: how many, and the one (when there's just one) */
export function logPlays(logId: number) {
	return rawDb()
		.prepare('SELECT season, episode, title FROM episode_watches WHERE log_id = ? ORDER BY season, episode')
		.all(logId) as { season: number; episode: number; title: string | null }[];
}

// --- Progress typed in before check-ins ---------------------------------------------------

/**
 * A show's saved progress (Current season/episode from before check-ins existed, an import, or
 * "Last episode you watched" on the Add form) marks every aired episode up to it as watched, once:
 * the values are removed in the same transaction. Nothing happens if the show already has plays.
 * Returns 'unmatched' (and keeps the values) when TMDB has no such season.
 */
export function applySavedProgress(userId: number, itemId: number, guide: EpisodeGuide) {
	const sqlite = rawDb();
	return sqlite.transaction((): 'applied' | 'unmatched' | 'none' => {
		const row = sqlite
			.prepare('SELECT custom FROM items WHERE id = ? AND user_id = ?')
			.get(itemId, userId) as { custom: string } | undefined;
		let custom: Record<string, unknown> = {};
		try {
			custom = JSON.parse(row?.custom ?? '{}');
		} catch {
			/* nothing saved */
		}
		const season = Number(custom.current_season);
		const episode = Number(custom.current_episode);
		if (!Number.isInteger(season) || season < 1) return 'none';
		if (sqlite.prepare('SELECT 1 FROM episode_watches WHERE item_id = ? LIMIT 1').get(itemId)) return 'none';
		if (!guide.seasons.some((s) => s.number === season)) return 'unmatched';
		const upTo = Number.isInteger(episode) && episode > 0 ? episode : 0;
		const plays = guide.seasons
			.filter((s) => s.number > 0 && s.number <= season)
			.flatMap((s) =>
				s.aired.filter((e) => s.number < season || e <= upTo).map((e) => ({ season: s.number, episode: e }))
			);
		insertWatches(userId, itemId, plays);
		// Used up: a raw update, so the show doesn't jump to the top of "recently updated"
		sqlite
			.prepare(
				`UPDATE items SET custom = json_remove(custom, '$.current_season', '$.current_episode') WHERE id = ?`
			)
			.run(itemId);
		return 'applied';
	})();
}

/** Applies a show's saved progress right away (after adding it); on failure the item page tries again. */
export async function applySavedProgressNow(userId: number, itemId: number, today: string) {
	const item = trackedShow(userId, itemId);
	return applySavedProgress(userId, item.id, await episodeGuide(item.providerId, today));
}

// --- The item page ----------------------------------------------------------------------

/** Progress, the next episode and the seasons, for the item page. Never fails: without TMDB it says what it knows. */
export async function loadTracker(userId: number, item: Show, today: string): Promise<TrackerView> {
	try {
		const guide = await episodeGuide(item.providerId, today);
		const applied = applySavedProgress(userId, item.id, guide);
		const t = computeTracker(guide, watchedEpisodes(item.id));
		let next: Extract<TrackerView, { ok: true }>['next'] = null;
		if (t.next) {
			const ep = await tmdbSeason(item.providerId, t.next.season)
				.then((s) => (s.episodes ?? []).find((e) => e.episode_number === t.next!.episode))
				.catch(() => undefined);
			next = {
				...t.next,
				title: ep?.name?.trim() || null,
				airDate: ep?.air_date ?? null
			};
		}
		return {
			ok: true,
			...t,
			next,
			unmatchedProgress: applied === 'unmatched' ? progressLabel(item.custom) : null
		};
	} catch (e) {
		const bySeason = new Map<number, number>();
		for (const w of watchedEpisodes(item.id)) bySeason.set(w.season, (bySeason.get(w.season) ?? 0) + 1);
		const seasons = [...bySeason]
			.map(([number, watched]) => ({ number, watched }))
			.sort((a, b) => (a.number || Infinity) - (b.number || Infinity));
		return {
			ok: false,
			error: tmdbProblem(e),
			seasons,
			watched: seasons.filter((s) => s.number > 0).reduce((n, s) => n + s.watched, 0)
		};
	}
}

/** One season's episodes with their plays, for the item page. Without TMDB, only the episodes watched. */
export async function seasonView(userId: number, itemId: number, season: number, today: string) {
	const item = trackedShow(userId, itemId);
	const plays = seasonPlays(item.id, season);
	try {
		const episodes = await seasonEpisodes(item.providerId, season, today);
		const listed = new Set(episodes.map((e) => e.number));
		return {
			ok: true as const,
			episodes: episodes.map((e) => ({ ...e, plays: plays.get(e.number) ?? [] })),
			// Plays of episodes TMDB no longer lists (renumbered or removed)
			unlisted: [...plays]
				.filter(([n]) => !listed.has(n))
				.sort(([a], [b]) => a - b)
				.map(([number, p]) => ({ number, plays: p }))
		};
	} catch (e) {
		return {
			ok: false as const,
			error:
				e instanceof ProviderError && e.code === 'notfound'
					? `TMDB no longer lists ${seasonLabel(season)}.`
					: tmdbProblem(e),
			episodes: [],
			unlisted: [...plays].sort(([a], [b]) => a - b).map(([number, p]) => ({ number, plays: p }))
		};
	}
}
