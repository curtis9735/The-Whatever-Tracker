import { error } from '@sveltejs/kit';
import { rawDb } from '../db';
import { tmdbMovieRuntime, tmdbSeason, tmdbTvShow } from '../providers/tmdb';
import { ProviderError } from '../providers/util';
import { getCategoryById, sharedSlug } from './categories';
import { removePlay, watchEpisode } from './episodes';
import { addLog, deleteLog, firstDoneStatus, getItem, updateItem } from './items';
import { episodeCode, seasonLabel, validEpisode, type TmdbSeason } from '$lib/episodes';
import {
	DEFAULT_EPISODE_MINUTES,
	DEFAULT_MOVIE_MINUTES,
	FINISHED_SHOWN_MS,
	runtimeFromFacts,
	watchKindOf,
	watchLabel,
	type FinishedCheckin,
	type LiveCheckin,
	type WatchImage,
	type WatchingState
} from '$lib/watching';
import type { MetadataFact, StatusDef } from '$lib/types';

/*
 * "Watching now": a live check-in for a movie or an episode. It runs for the movie's or episode's
 * length; when the time is up (the scheduler, or the next page load) the movie or episode is marked
 * watched, the same as an instant check-in on the check-in day. Check-ins are each person's own, like
 * logs and episodes, so anyone who can see the item can check in, even to a list shared to view.
 */

/** Something wrong with what was asked for (shown as is). 409: the check-in already ended. */
export class WatchError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

/** Another check-in is running: the person picks whether to mark it watched or cancel it first */
export class WatchConflict extends Error {
	title: string;
	label: string | null;
	itemId: number;
	constructor(running: LiveCheckin) {
		super(`You're watching ${running.title}.`);
		this.title = running.title;
		this.label = watchLabel(running);
		this.itemId = running.itemId;
	}
}

/** Ended check-ins are kept this long (for the "Watched" card and Undo), then pruned */
const KEEP_ENDED_MS = 30 * 86_400_000;

/** YYYY-MM-DD of `now` in the server's time zone (what todayIso() gives at that moment) */
function dayOf(now: number) {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Reading check-ins ------------------------------------------------------------------

/** 'finishing': claimed, the play or log is being written (the final outcome is set once it is) */
type CheckinOutcome = 'finishing' | 'auto' | 'early' | 'cancelled' | 'undone';

interface Row {
	id: number;
	userId: number;
	itemId: number;
	season: number | null;
	episode: number | null;
	episodeTitle: string | null;
	checkedInAt: number;
	date: string;
	durationMs: number;
	runtimeKnown: number;
	endsAt: number;
	pausedAt: number | null;
	statusBefore: string | null;
	statusSet: string | null;
	endedAt: number | null;
	outcome: CheckinOutcome | null;
	logId: number | null;
	watchId: number | null;
	statusAfter: string | null;
	statusFinal: string | null;
	undoStatus: string | null;
	dismissed: number;
}

/** A check-in with what the viewer sees of its item: the title, the list (as they reach it) and the cover */
interface ViewRow extends Row {
	title: string;
	slug: string;
	icon: string;
	statuses: string;
	ownerId: number;
	ownerUsername: string;
	/** The list is still the person's or shared with them */
	visible: number;
	imgKind: WatchImage['kind'] | null;
	imgPath: string | null;
	imgThumb: string | null;
	imgSource: string | null;
}

const COLUMNS = `c.id, c.user_id AS userId, c.item_id AS itemId, c.season, c.episode, c.episode_title AS episodeTitle,
	c.checked_in_at AS checkedInAt, c.date, c.duration_ms AS durationMs, c.runtime_known AS runtimeKnown,
	c.ends_at AS endsAt, c.paused_at AS pausedAt, c.status_before AS statusBefore, c.status_set AS statusSet,
	c.ended_at AS endedAt, c.outcome, c.log_id AS logId, c.watch_id AS watchId, c.status_after AS statusAfter,
	c.status_final AS statusFinal, c.undo_status AS undoStatus, c.dismissed`;

const VIEW_SELECT = `SELECT ${COLUMNS}, i.title, cat.slug, cat.icon, cat.statuses, cat.user_id AS ownerId,
		o.username AS ownerUsername,
		(cat.user_id = c.user_id OR EXISTS (SELECT 1 FROM list_shares s WHERE s.category_id = cat.id AND s.user_id = c.user_id)) AS visible,
		im.kind AS imgKind, im.path AS imgPath, im.thumb_path AS imgThumb, im.source_url AS imgSource
	 FROM checkins c
	 JOIN items i ON i.id = c.item_id
	 JOIN categories cat ON cat.id = i.category_id
	 JOIN users o ON o.id = cat.user_id
	 LEFT JOIN images im ON im.id = i.cover_image_id`;

function target(r: ViewRow) {
	return {
		itemId: r.itemId,
		title: r.title,
		kind: r.season === null ? ('movie' as const) : ('episode' as const),
		season: r.season,
		episode: r.episode,
		episodeTitle: r.episodeTitle,
		categorySlug: r.ownerId === r.userId ? r.slug : sharedSlug(r.slug, r.ownerUsername),
		categoryIcon: r.icon,
		image: r.imgKind
			? { kind: r.imgKind, path: r.imgPath, thumbPath: r.imgThumb, sourceUrl: r.imgSource }
			: null
	};
}

function toLive(r: ViewRow): LiveCheckin {
	return {
		...target(r),
		id: r.id,
		checkedInAt: r.checkedInAt,
		durationMs: r.durationMs,
		endsAt: r.endsAt,
		pausedAt: r.pausedAt,
		runtimeKnown: !!r.runtimeKnown
	};
}

function toFinished(r: ViewRow): FinishedCheckin {
	let statuses: StatusDef[] = [];
	try {
		statuses = JSON.parse(r.statuses);
	} catch {
		/* no labels */
	}
	return {
		...target(r),
		id: r.id,
		endedAt: r.endedAt!,
		how: r.outcome === 'early' ? 'early' : 'auto',
		logId: r.logId,
		statusLabel: r.statusAfter ? (statuses.find((s) => s.key === r.statusAfter)?.label ?? null) : null
	};
}

function viewRow(id: number) {
	return rawDb().prepare(`${VIEW_SELECT} WHERE c.id = ?`).get(id) as ViewRow | undefined;
}

/**
 * The person's live check-in (running or paused), if any. One on an item they can no longer see (the
 * list was unshared) is ended quietly instead, so it's never shown or named.
 */
function liveRow(userId: number, now: number) {
	const r = rawDb().prepare(`${VIEW_SELECT} WHERE c.user_id = ? AND c.ended_at IS NULL`).get(userId) as
		ViewRow | undefined;
	if (r && !r.visible) {
		endQuietly(r, now);
		return undefined;
	}
	return r;
}

/**
 * Puts back the status a check-in set, while it's still that. Raw SQL, as the person may no longer be
 * able to see the item (the list was unshared).
 */
function restoreStatus(r: Row) {
	if (r.statusSet === null) return;
	const sqlite = rawDb();
	const owned = sqlite.prepare('SELECT 1 FROM items WHERE id = ? AND user_id = ?').get(r.itemId, r.userId);
	sqlite
		.prepare(
			owned
				? 'UPDATE items SET status = ? WHERE id = ? AND user_id = ? AND status = ?'
				: 'UPDATE item_progress SET status = ? WHERE item_id = ? AND user_id = ? AND status = ?'
		)
		.run(r.statusBefore, r.itemId, r.userId, r.statusSet);
}

/** Ends a check-in without marking anything (its item is gone from view); the status goes back */
function endQuietly(r: Row, now: number) {
	const claimed = rawDb()
		.prepare("UPDATE checkins SET ended_at = ?, outcome = 'cancelled' WHERE id = ? AND ended_at IS NULL")
		.run(now, r.id).changes;
	if (claimed) restoreStatus(r);
}

/**
 * What every page shows: the person's live check-in, or else the one that just finished (until it's
 * dismissed or a few hours have passed). Indexed look-ups only, no TMDB.
 */
export function currentWatching(userId: number, now = Date.now()): WatchingState {
	const live = liveRow(userId, now);
	if (live) return { live: toLive(live), finished: null, now };
	const finished = rawDb()
		.prepare(
			`${VIEW_SELECT} WHERE c.user_id = ? AND c.ended_at >= ? AND c.outcome IN ('auto', 'early')
				AND c.dismissed = 0
			 ORDER BY c.ended_at DESC, c.id DESC LIMIT 1`
		)
		.get(userId, now - FINISHED_SHOWN_MS) as ViewRow | undefined;
	return { live: null, finished: finished?.visible ? toFinished(finished) : null, now };
}

/**
 * One of the person's own check-ins, still live: 404 when it's gone or someone else's, 409 when it
 * already ended (a stale page)
 */
function ownLive(userId: number, id: number) {
	const r = rawDb()
		.prepare(`SELECT ${COLUMNS} FROM checkins c WHERE c.id = ? AND c.user_id = ?`)
		.get(id, userId) as Row | undefined;
	if (!r) error(404, 'Check-in not found');
	if (r.endedAt !== null) throw new WatchError('That check-in already ended.', 409);
	return r;
}

// --- How long it runs -------------------------------------------------------------------

// TMDB's answers are saved, so lengths and names are looked up even when no key is set right now

/** A show's usual episode length: its latest episode's */
async function showRuntime(tmdbId: string) {
	return tmdbTvShow(tmdbId)
		.then((s) => s.last_episode_to_air?.runtime || null)
		.catch(() => null);
}

/**
 * The episode's name and length. Episodes TMDB doesn't list are refused (as watchEpisode does); when
 * TMDB can't be reached it goes ahead unnamed, with a usual length.
 */
async function episodeInfo(tmdbId: string, season: number, episode: number) {
	const find = (list: TmdbSeason) => (list.episodes ?? []).find((x) => x.episode_number === episode);
	let ep;
	try {
		ep = find(await tmdbSeason(tmdbId, season));
		// Added since the list was saved? Ask TMDB again before refusing
		if (!ep) ep = find(await tmdbSeason(tmdbId, season, undefined, { fresh: true }));
	} catch (e) {
		if (e instanceof ProviderError && e.code === 'notfound') {
			throw new WatchError(`TMDB has no ${seasonLabel(season)} for this show.`);
		}
		return { title: null, runtime: await showRuntime(tmdbId) };
	}
	if (!ep)
		throw new WatchError(`${episodeCode(season, episode)} isn't in TMDB's episode list for this show.`);
	return { title: ep.name?.trim() || null, runtime: ep.runtime || (await showRuntime(tmdbId)) };
}

async function movieRuntime(tmdbId: string, facts: MetadataFact[] | undefined) {
	const fromTmdb = await tmdbMovieRuntime(tmdbId).catch(() => null);
	return fromTmdb ?? runtimeFromFacts(facts);
}

// --- Starting ---------------------------------------------------------------------------

/**
 * Checks in to a movie, or an episode of a show (`pick`), live: the item becomes "Watching" and a timer
 * runs for its length. Another check-in already running is a WatchConflict unless `replace` says what
 * to do with it; the same one again (a double tap) is returned as it is.
 */
export async function startWatching(
	userId: number,
	itemId: number,
	pick: { season: number; episode: number } | null,
	{ replace }: { replace?: 'finish' | 'cancel' } = {},
	now = Date.now()
): Promise<LiveCheckin> {
	const item = getItem(userId, itemId);
	const kind = watchKindOf(item);
	if (!kind) throw new WatchError('Only movies and shows linked to TMDB can be checked in to.');
	if (kind === 'movie') pick = null;
	else if (!pick || !validEpisode(pick.season, pick.episode))
		throw new WatchError('Pick a season and episode.');

	// One whose time is up is marked watched first, so it doesn't count as running
	await settleMine(userId, now);
	const same = (r: ViewRow) =>
		r.itemId === itemId && r.season === (pick?.season ?? null) && r.episode === (pick?.episode ?? null);
	const running = liveRow(userId, now);
	if (running && same(running)) return toLive(running);
	if (running && !replace) throw new WatchConflict(toLive(running));

	const info =
		kind === 'episode'
			? await episodeInfo(item.providerId!, pick!.season, pick!.episode)
			: {
					title: null,
					runtime: await movieRuntime(item.providerId!, (item.metadata?.facts as MetadataFact[]) ?? undefined)
				};
	const minutes = info.runtime ?? (kind === 'movie' ? DEFAULT_MOVIE_MINUTES : DEFAULT_EPISODE_MINUTES);

	// Whatever is running now (it may have changed while TMDB answered) makes way
	const before = liveRow(userId, now);
	if (before && same(before)) return toLive(before);
	if (before && replace === 'finish') await finishRow(before, 'early', now);
	else if (before && replace === 'cancel') cancelRow(userId, before, now);
	else if (before) throw new WatchConflict(toLive(before));

	const sqlite = rawDb();
	const { category } = getCategoryById(userId, item.categoryId);
	const current = getItem(userId, itemId).status;
	const active = category.statuses.find((s) => s.group === 'active')?.key ?? null;
	const inActive = category.statuses.find((s) => s.key === current)?.group === 'active';
	const statusSet = active && !inActive ? active : null;
	const started = sqlite.transaction(() => {
		// Nothing waits from here on, so a second tap can't slip in: it finds this one
		const again = liveRow(userId, now);
		if (again) return { again };
		// The finished card goes once something new starts
		sqlite
			.prepare(
				'UPDATE checkins SET dismissed = 1 WHERE user_id = ? AND ended_at IS NOT NULL AND dismissed = 0'
			)
			.run(userId);
		const durationMs = minutes * 60_000;
		const id = Number(
			sqlite
				.prepare(
					`INSERT INTO checkins (user_id, item_id, season, episode, episode_title, checked_in_at, date,
						duration_ms, runtime_known, ends_at, status_before, status_set, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					userId,
					itemId,
					pick?.season ?? null,
					pick?.episode ?? null,
					info.title,
					now,
					dayOf(now),
					durationMs,
					info.runtime ? 1 : 0,
					now + durationMs,
					current,
					statusSet,
					now
				).lastInsertRowid
		);
		return { id };
	})();
	if (started.again) {
		if (same(started.again)) return toLive(started.again);
		throw new WatchConflict(toLive(started.again));
	}
	if (statusSet) updateItem(userId, itemId, { status: statusSet });
	return toLive(viewRow(started.id)!);
}

// --- While it runs ----------------------------------------------------------------------

/** Stops the clock. A paused check-in never finishes or ends on its own. */
export async function pauseWatching(userId: number, id: number, now = Date.now()) {
	const r = ownLive(userId, id);
	if (r.pausedAt !== null) return;
	// Its time was already up: it's watched, not paused
	if (r.endsAt <= now) {
		await finishRow(r, 'auto', now);
		throw new WatchError('That check-in already ended.', 409);
	}
	rawDb()
		.prepare('UPDATE checkins SET paused_at = ? WHERE id = ? AND ended_at IS NULL AND paused_at IS NULL')
		.run(now, id);
}

/** Starts the clock again: it ends later by as long as it was paused */
export function resumeWatching(userId: number, id: number, now = Date.now()) {
	ownLive(userId, id);
	rawDb()
		.prepare(
			`UPDATE checkins SET ends_at = ends_at + MAX(0, ? - paused_at), paused_at = NULL
			 WHERE id = ? AND ended_at IS NULL AND paused_at IS NOT NULL`
		)
		.run(now, id);
}

/** "Mark watched now": finishes it before its time is up */
export async function finishWatching(
	userId: number,
	id: number,
	now = Date.now()
): Promise<FinishedCheckin | null> {
	const r = ownLive(userId, id);
	if (!(await finishRow(r, 'early', now))) return null;
	const v = viewRow(id);
	return v && v.outcome === 'early' ? toFinished(v) : null;
}

/** Ends it without marking anything; the status goes back unless the person changed it meanwhile */
export function cancelWatching(userId: number, id: number, now = Date.now()) {
	cancelRow(userId, ownLive(userId, id), now);
}

function cancelRow(userId: number, r: Row, now: number) {
	const claimed = rawDb()
		.prepare("UPDATE checkins SET ended_at = ?, outcome = 'cancelled' WHERE id = ? AND ended_at IS NULL")
		.run(now, r.id).changes;
	if (!claimed || !r.statusSet) return;
	try {
		if (getItem(userId, r.itemId).status === r.statusSet) {
			updateItem(userId, r.itemId, { status: r.statusBefore });
		}
	} catch {
		/* the item is gone from view: nothing to put back */
	}
}

// --- Finishing --------------------------------------------------------------------------

/**
 * Marks it watched, once: the row is claimed first as 'finishing' (only one caller gets it, whether the
 * scheduler, a page load or "Mark watched now"), then the log or play is written, and only then does it
 * become 'auto' or 'early' (shown as watched, and undoable). A failure there (the item is gone from
 * view…) ends it as cancelled instead. Never throws. Returns whether this call finished it.
 */
async function finishRow(r: Row, how: 'auto' | 'early', now: number): Promise<boolean> {
	const sqlite = rawDb();
	const claimed = sqlite
		.prepare("UPDATE checkins SET ended_at = ?, outcome = 'finishing' WHERE id = ? AND ended_at IS NULL")
		.run(now, r.id).changes;
	if (!claimed) return false;
	let logId: number | null = null;
	let watchId: number | null = null;
	try {
		const item = getItem(r.userId, r.itemId);
		const { statuses } = getCategoryById(r.userId, item.categoryId).category;
		const pre = item.status;
		// We set the status it has now: without this check-in it would be what it was before
		const ours = r.statusSet !== null && pre === r.statusSet;
		const date = r.date;
		if (r.season === null || r.episode === null) {
			logId = addLog(r.userId, r.itemId, { date }, statuses, { promote: false }).id;
			const group = statuses.find((s) => s.key === pre)?.group;
			const done = firstDoneStatus(statuses);
			const finish = ours || (r.statusSet === null && (!pre || group === 'planned' || group === 'active'));
			if (finish && done && done !== pre) updateItem(r.userId, r.itemId, { status: done });
		} else {
			// The usual check-in rules decide the status, from where it stood before the check-in
			// Named at check-in, unless TMDB was down then: ask once more, but never fail over it
			const title =
				r.episodeTitle ??
				(await tmdbSeason(item.providerId!, r.season)
					.then((s) => s.episodes?.find((x) => x.episode_number === r.episode)?.name?.trim() || null)
					.catch(() => null));
			if (ours) updateItem(r.userId, r.itemId, { status: r.statusBefore });
			const w = await watchEpisode(
				r.userId,
				r.itemId,
				{ season: r.season, episode: r.episode },
				{ date },
				dayOf(now),
				{ title }
			);
			logId = w.logId;
			watchId = w.watchId;
		}
		const final = getItem(r.userId, r.itemId).status;
		sqlite
			.prepare(
				`UPDATE checkins SET outcome = ?, log_id = ?, watch_id = ?, status_after = ?, status_final = ?,
					undo_status = ?
				 WHERE id = ?`
			)
			.run(how, logId, watchId, final !== pre ? final : null, final, ours ? r.statusBefore : pre, r.id);
		return true;
	} catch (e) {
		console.warn(`[watching] check-in ${r.id} could not be marked watched`, e);
		// A play that was written stays (with its Undo); otherwise nothing was watched
		if (logId || watchId)
			sqlite
				.prepare('UPDATE checkins SET outcome = ?, log_id = ?, watch_id = ? WHERE id = ?')
				.run(how, logId, watchId, r.id);
		else {
			sqlite.prepare("UPDATE checkins SET outcome = 'cancelled' WHERE id = ?").run(r.id);
			restoreStatus(r);
		}
		return false;
	}
}

function dueRows(userId: number | null, now: number) {
	return rawDb()
		.prepare(
			`SELECT ${COLUMNS} FROM checkins c
			 WHERE c.ended_at IS NULL AND c.paused_at IS NULL AND c.ends_at <= ? ${userId === null ? '' : 'AND c.user_id = ?'}`
		)
		.all(...(userId === null ? [now] : [now, userId])) as Row[];
}

/** Marks the person's check-ins whose time is up as watched (before a page shows them) */
export async function settleMine(userId: number, now = Date.now()) {
	for (const r of dueRows(userId, now)) await finishRow(r, 'auto', now);
}

/** Everyone's check-ins whose time is up are marked watched, and ones that ended long ago are removed */
export async function settleDue(now = Date.now()) {
	for (const r of dueRows(null, now)) await finishRow(r, 'auto', now);
	rawDb()
		.prepare('DELETE FROM checkins WHERE ended_at IS NOT NULL AND ended_at < ?')
		.run(now - KEEP_ENDED_MS);
}

// --- After it finished ------------------------------------------------------------------

/** Takes back what finishing did: the play or log goes, and the status returns unless changed since. Twice is harmless. */
export async function undoFinished(userId: number, id: number) {
	const sqlite = rawDb();
	const r = sqlite
		.prepare(`SELECT ${COLUMNS} FROM checkins c WHERE c.id = ? AND c.user_id = ?`)
		.get(id, userId) as Row | undefined;
	if (!r) error(404, 'Check-in not found');
	if (r.outcome === 'finishing') throw new WatchError('Still saving, try again in a moment.', 409);
	if (r.outcome !== 'auto' && r.outcome !== 'early') return;
	getItem(userId, r.itemId);
	const claimed = sqlite
		.prepare(
			"UPDATE checkins SET outcome = 'undone', dismissed = 1 WHERE id = ? AND outcome IN ('auto', 'early')"
		)
		.run(id).changes;
	if (!claimed) return;
	if (r.watchId) await removePlay(userId, r.watchId, r.itemId);
	else if (r.logId) {
		const exists = sqlite
			.prepare('SELECT 1 FROM item_logs WHERE id = ? AND user_id = ?')
			.get(r.logId, userId);
		if (exists) await deleteLog(userId, r.logId);
	}
	const current = getItem(userId, r.itemId).status;
	if (current === r.statusFinal && current !== r.undoStatus) {
		updateItem(userId, r.itemId, { status: r.undoStatus });
	}
}

/** Closes the "Watched" card */
export function dismissFinished(userId: number, id: number) {
	rawDb().prepare('UPDATE checkins SET dismissed = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

// --- In the background ------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** Every 30 seconds (and shortly after startup), check-ins whose time is up are marked watched */
export function startWatchingScheduler() {
	if (timer) return;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			await settleDue();
		} catch (e) {
			console.error('[watching] settling check-ins failed', e);
		} finally {
			busy = false;
		}
	};
	setTimeout(() => void tick(), 5_000).unref();
	timer = setInterval(() => void tick(), 30_000);
	timer.unref();
}
