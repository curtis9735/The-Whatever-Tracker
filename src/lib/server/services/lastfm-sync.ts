import { eq } from 'drizzle-orm';
import { db, rawDb, schema } from '../db';
import { keys } from '../settings';
import { foldName } from '../providers/artist-images';
import { lastfm, getRecentTracks, getUserInfo, LastfmError, type Scrobble } from '../providers/lastfm';
import { ProviderError } from '../providers/util';
import {
	albumKey,
	buildAlbumIndex,
	findAlbumItem,
	indexAdd,
	lastfmAlbumId,
	type AlbumIndex
} from '../album-match';
import { reindexItem } from '../search/local';
import { ALBUM_KINDS } from '$lib/kinds';
import type { AlbumTrack, StatusDef } from '$lib/types';
import { createCategoryFromTemplate, listCategories } from './categories';
import { listAccess, listSharesOf } from './access';
import { localDay, refreshLastLogged } from './items';

/*
 * Listening history from last.fm. Every person connects their own username. Their plays are stored in
 * lastfm_scrobbles; each album they've played becomes an item in the list they picked (unless it
 * matches one already there), with one log per album per listening day. The history is read through
 * one "window job": plays from `jobFrom` (exclusive) up to `jobEnd`, newest first, 200 per request,
 * with `jobTo` as the cursor. A backfill is the window 0…now; an incremental sync is syncedUntil…now;
 * the one-time "names" job (for plays stored before readable track names were kept) is 0…now again.
 * A page's plays and the cursor move are committed together, so a restart resumes exactly there.
 */

const PAGE = 200;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A full page is 200 plays, 199 when the "now playing" entry (dropped by the parser) was part of it */
const FULL_PAGE = PAGE - 1;
/**
 * Phones and scrobblers submit plays late, with their old timestamps (last.fm takes them up to about two
 * weeks back). So a sync doesn't start exactly at the watermark: it re-reads the last two days, and once
 * a day the last two weeks. Plays already stored are ignored, so this costs requests, not duplicates.
 */
const OVERLAP_S = 2 * 86_400;
const DEEP_OVERLAP_S = 14 * 86_400;

/** Something wrong with what the person asked for (shown as is) */
export class LastfmUserError extends Error {
	constructor(
		message: string,
		public code: 'setup' | 'user' | 'private' | 'list' | 'busy' | 'other' = 'other'
	) {
		super(message);
	}
}

export const NOT_SET_UP = "last.fm isn't set up yet. Ask an admin to add an API key.";

// --- Views --------------------------------------------------------------------------------

export type LastfmErrorCode = 'notfound' | 'private' | 'auth' | 'rate' | 'unreachable' | 'list' | 'other';

export interface LastfmAccountView {
	/** Only ever the signed-in person's own */
	username: string;
	categoryId: number | null;
	categoryName: string | null;
	syncEvery: 'hourly' | 'daily';
	journalMode: 'group' | 'hide' | 'all';
	/** 'importing': the first full import; 'syncing': catching up; 'naming': the one-time fill-in of track
	 * names; 'idle': up to date (or waiting to retry) */
	state: 'importing' | 'syncing' | 'naming' | 'idle';
	/** 0–99 while importing or filling in names, null when the total isn't known yet or nothing is running */
	percent: number | null;
	/** Plays read so far, of how many (when known), and the albums found so far */
	progress: { done: number; total: number | null; albums: number } | null;
	plays: number;
	albums: number;
	backfilled: boolean;
	/** ms since the epoch */
	lastSyncAt: number | null;
	nextSyncAt: number;
	error: { code: LastfmErrorCode; message: string; retryAt: number | null } | null;
	/** Albums the person deleted that a later play doesn't bring back */
	removedCount: number;
	connectedAt: number;
}

type AccountRow = typeof schema.lastfmAccounts.$inferSelect;

function errorText(a: AccountRow): string {
	switch (a.errorCode) {
		case 'auth':
			return "last.fm isn't accepting the API key. An admin needs to check it in Settings → Integrations.";
		case 'notfound':
			return `There's no last.fm user called '${a.username}' any more. Stop syncing and connect again with the right name.`;
		case 'private':
			return `${a.username}'s listening history is private on last.fm. On last.fm open Settings → Privacy, untick 'Hide recent listening'.`;
		case 'rate':
			return 'last.fm is limiting requests right now.';
		case 'unreachable':
			return "Couldn't reach last.fm.";
		case 'list':
			return a.errorMessage || "You can't add to that list any more. Pick another list.";
		default:
			return a.errorMessage || 'Something went wrong talking to last.fm.';
	}
}

function removedCountOf(userId: number) {
	return (
		rawDb()
			.prepare(
				'SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ? AND item_id IS NULL AND linked_at IS NOT NULL'
			)
			.get(userId) as { n: number }
	).n;
}

function viewOf(a: AccountRow, now = Date.now()): LastfmAccountView {
	const sqlite = rawDb();
	const cat = a.categoryId
		? (sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(a.categoryId) as
				{ name: string } | undefined)
		: undefined;
	const running = a.job !== null;
	const albumsNow = running
		? (
				sqlite.prepare('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?').get(a.userId) as {
					n: number;
				}
			).n
		: a.albums;
	const total = a.jobTotal && a.jobTotal > 0 ? a.jobTotal : null;
	const blocking = a.errorCode && a.errorCode !== 'list';
	const retryAt =
		a.nextSyncAt > now && a.errorCode !== 'auth' && a.errorCode !== 'notfound' ? a.nextSyncAt : null;
	return {
		username: a.username,
		categoryId: a.categoryId,
		categoryName: cat?.name ?? null,
		syncEvery: a.syncEvery,
		journalMode: a.journalMode,
		state:
			a.job === 'backfill'
				? 'importing'
				: a.job === 'sync'
					? 'syncing'
					: a.job === 'names'
						? 'naming'
						: 'idle',
		percent:
			(a.job === 'backfill' || a.job === 'names') && total
				? Math.min(99, Math.floor((a.jobDone / total) * 100))
				: null,
		progress: running ? { done: a.jobDone, total, albums: albumsNow } : null,
		plays: a.plays,
		albums: albumsNow,
		backfilled: !!a.backfilledAt,
		lastSyncAt: a.lastSyncAt ? a.lastSyncAt.getTime() : null,
		nextSyncAt: a.nextSyncAt,
		error: a.errorCode
			? { code: a.errorCode as LastfmErrorCode, message: errorText(a), retryAt: blocking ? retryAt : null }
			: null,
		removedCount: removedCountOf(a.userId),
		connectedAt: a.connectedAt.getTime()
	};
}

function accountRow(userId: number): AccountRow | undefined {
	return db().select().from(schema.lastfmAccounts).where(eq(schema.lastfmAccounts.userId, userId)).get();
}

/** The person's own connection, or null. Nobody else's username is ever returned. */
export function getLastfmAccount(userId: number): LastfmAccountView | null {
	const a = accountRow(userId);
	return a ? viewOf(a) : null;
}

// --- Lists an import can go into ------------------------------------------------------------

export interface LastfmTargetList {
	id: number;
	name: string;
	icon: string;
	/** Their own list (otherwise shared with them to edit) */
	own: boolean;
	/** Whose list it is, when it isn't theirs */
	ownerName: string | null;
	/** The other people who see this list (for the sharing warnings) */
	otherPeople: string[];
	/** It already holds an album source (last.fm or MusicBrainz) */
	hasAlbumKind: boolean;
	/** It has a "done" status for plays to move albums to */
	hasDoneStatus: boolean;
	/** The one connecting picks first: their own first list with an album source */
	isDefault: boolean;
}

/** Lists the person can add to (their own, and lists shared with them to edit), album lists first */
export function lastfmTargetLists(userId: number): LastfmTargetList[] {
	const lists = listCategories(userId).filter((c) => c.access !== 'view');
	const out = lists.map((c) => {
		const own = c.access === 'owner';
		const shares = listSharesOf(c.id);
		// On somebody else's list only the owner is named: the warning adds "and anyone else it's shared with"
		const people = own ? shares.map((s) => s.displayName) : [c.ownerName ?? ''].filter(Boolean);
		return {
			id: c.id,
			name: c.name,
			icon: c.icon,
			own,
			ownerName: own ? null : c.ownerName,
			otherPeople: people,
			hasAlbumKind: c.providerKinds.some((k) => (ALBUM_KINDS as readonly string[]).includes(k)),
			hasDoneStatus: c.statuses.some((s) => s.group === 'done'),
			isDefault: false
		};
	});
	out.sort((a, b) => Number(b.hasAlbumKind) - Number(a.hasAlbumKind) || Number(b.own) - Number(a.own));
	const first = out.find((l) => l.own && l.hasAlbumKind);
	if (first) first.isDefault = true;
	return out;
}

// --- The list an account puts albums in -----------------------------------------------------

interface ListCtx {
	categoryId: number;
	ownerId: number;
	name: string;
	statuses: StatusDef[];
}

/** The list, if the account still has one it may add to; otherwise why not */
function resolveList(a: AccountRow): { ctx: ListCtx; error?: undefined } | { ctx: null; error: string } {
	if (!a.categoryId) return { ctx: null, error: "You can't add to a list any more. Pick another list." };
	const c = rawDb()
		.prepare('SELECT id, user_id AS ownerId, name, statuses FROM categories WHERE id = ?')
		.get(a.categoryId) as { id: number; ownerId: number; name: string; statuses: string } | undefined;
	const access = c ? listAccess(a.userId, c.id) : null;
	if (!c || (access !== 'owner' && access !== 'edit')) {
		return { ctx: null, error: `You can't add to '${c?.name ?? 'that list'}' any more. Pick another list.` };
	}
	return { ctx: { categoryId: c.id, ownerId: c.ownerId, name: c.name, statuses: JSON.parse(c.statuses) } };
}

/** The person may write to the list: it's theirs, or shared with them to edit */
function canEdit(userId: number, categoryId: number) {
	const access = listAccess(userId, categoryId);
	return access === 'owner' || access === 'edit';
}

const doneKeyOf = (statuses: StatusDef[]) => statuses.find((s) => s.group === 'done')?.key ?? null;

// --- Writing plays --------------------------------------------------------------------------

/** What one tick of the scheduler remembers between pages, so a long import doesn't re-read the list each page */
export interface RunCache {
	indexes: Map<number, AlbumIndex>;
}

export const newRunCache = (): RunCache => ({ indexes: new Map() });

/** How the window cursor moves in the same transaction that stores a page */
export interface CursorPatch {
	jobTo?: number;
	jobTotal?: number | null;
	addDone?: number;
	/** The window is complete: sync is up to date, the job ends */
	finish?: boolean;
}

interface AlbumRow {
	id: number;
	userId: number;
	key: string;
	artist: string;
	title: string;
	mbid: string | null;
	imageUrl: string | null;
	itemId: number | null;
	linkedAt: number | null;
	createdItem: number;
	promoted: number;
	statusBefore: string | null;
	plays: number;
	firstUts: number | null;
	lastUts: number | null;
}

const ALBUM_COLS = `id, user_id AS userId, key, artist, title, mbid, image_url AS imageUrl, item_id AS itemId,
	linked_at AS linkedAt, created_item AS createdItem, promoted, status_before AS statusBefore, plays,
	first_uts AS firstUts, last_uts AS lastUts`;

/** Which days (YYYY-MM-DD) of an album need their log written: some, or 'all' of them */
type Work = Map<number, Set<string> | 'all'>;

function recountAlbums(ids: Iterable<number>) {
	const sqlite = rawDb();
	const count = sqlite.prepare(
		`UPDATE lastfm_albums SET
			plays = (SELECT COUNT(*) FROM lastfm_scrobbles s WHERE s.album_id = lastfm_albums.id),
			first_uts = (SELECT MIN(uts) FROM lastfm_scrobbles s WHERE s.album_id = lastfm_albums.id),
			last_uts = (SELECT MAX(uts) FROM lastfm_scrobbles s WHERE s.album_id = lastfm_albums.id)
		 WHERE id = ?`
	);
	for (const id of ids) count.run(id);
}

/** The statuses rule for one list: the first done status, and which keys are "planned" */
function rulesOf(statusesJson: string) {
	const statuses = JSON.parse(statusesJson) as StatusDef[];
	return {
		doneKey: doneKeyOf(statuses),
		planned: new Set(statuses.filter((s) => s.group === 'planned').map((s) => s.key))
	};
}

/**
 * For albums that have plays: find or create their item (once per album, ever), write one log per
 * listening day, and move the person's own progress. All in the caller's transaction.
 */
function linkAndWrite(userId: number, ctx: ListCtx, work: Work, run?: RunCache) {
	const sqlite = rawDb();
	const now = Date.now();
	recountAlbums(work.keys());

	const getAlbum = sqlite.prepare(`SELECT ${ALBUM_COLS} FROM lastfm_albums WHERE id = ?`);
	const itemExists = sqlite.prepare('SELECT 1 FROM items WHERE id = ? AND category_id = ?');
	const insertItem = sqlite.prepare(
		`INSERT INTO items (user_id, category_id, title, subtitle, provider, provider_kind, provider_id,
			external_url, metadata, created_at, updated_at)
		 VALUES (@owner, @category, @title, @subtitle, 'lastfm', 'album', @pid, @url, @metadata, @at, @at)
		 ON CONFLICT (user_id, provider, provider_kind, provider_id) DO NOTHING RETURNING id`
	);
	const byProviderId = sqlite.prepare(
		`SELECT id, category_id AS categoryId FROM items
		 WHERE user_id = ? AND provider = 'lastfm' AND provider_kind = 'album' AND provider_id = ?`
	);
	const insertCover = sqlite.prepare(
		`INSERT INTO images (user_id, item_id, kind, source_url, sort_order, created_at)
		 VALUES (?, ?, 'url_link', ?, 0, ?) RETURNING id`
	);
	const setCover = sqlite.prepare('UPDATE items SET cover_image_id = ? WHERE id = ?');
	const link = sqlite.prepare(
		'UPDATE lastfm_albums SET item_id = ?, linked_at = ?, created_item = ? WHERE id = ?'
	);
	const datesOf = sqlite.prepare(
		'SELECT date, COUNT(*) AS n, MAX(uts) AS last FROM lastfm_scrobbles WHERE album_id = ? GROUP BY date'
	);
	const dayOf = sqlite.prepare(
		'SELECT COUNT(*) AS n, MAX(uts) AS last FROM lastfm_scrobbles WHERE album_id = ? AND date = ?'
	);
	const upsertLog = sqlite.prepare(
		`INSERT INTO item_logs (item_id, user_id, date, custom, external, source, source_key, created_at)
		 VALUES (?, ?, ?, '{}', ?, 'lastfm', ?, ?)
		 ON CONFLICT (user_id, source, source_key) DO UPDATE SET external = excluded.external, item_id = excluded.item_id`
	);
	const itemRow = sqlite.prepare(
		'SELECT user_id AS ownerId, category_id AS categoryId, status, updated_at AS updatedAt FROM items WHERE id = ?'
	);
	const progressRow = sqlite.prepare(
		'SELECT status, updated_at AS updatedAt FROM item_progress WHERE item_id = ? AND user_id = ?'
	);
	const lastLogged = sqlite.prepare('SELECT MAX(date) AS d FROM item_logs WHERE item_id = ? AND user_id = ?');
	const setOwner = sqlite.prepare(
		'UPDATE items SET status = ?, last_logged_at = ?, updated_at = ? WHERE id = ?'
	);
	const setOther = sqlite.prepare(
		`INSERT INTO item_progress (item_id, user_id, status, last_logged_at, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (item_id, user_id) DO UPDATE SET status = excluded.status,
			last_logged_at = excluded.last_logged_at, updated_at = excluded.updated_at`
	);
	const markPromoted = sqlite.prepare(
		'UPDATE lastfm_albums SET promoted = 1, status_before = ? WHERE id = ?'
	);
	const statusRules = new Map<number, ReturnType<typeof rulesOf>>();
	const rulesFor = (categoryId: number) => {
		let r = statusRules.get(categoryId);
		if (!r) {
			const c = sqlite.prepare('SELECT statuses FROM categories WHERE id = ?').get(categoryId) as {
				statuses: string;
			};
			r = rulesOf(c.statuses);
			statusRules.set(categoryId, r);
		}
		return r;
	};

	let ix: AlbumIndex | null = null;
	const index = () => {
		if (run) {
			let cached = run.indexes.get(ctx.categoryId);
			if (!cached) run.indexes.set(ctx.categoryId, (cached = buildAlbumIndex(ctx.categoryId)));
			return cached;
		}
		return (ix ??= buildAlbumIndex(ctx.categoryId));
	};

	/** The item an album belongs in: a match in the list, else a new item. Null when it can't be placed. */
	const resolve = (a: AlbumRow): { id: number; created: boolean } | null => {
		const pid = lastfmAlbumId(a.artist, a.title);
		const ixs = index();
		let id = findAlbumItem(ixs, a.artist, a.title, pid);
		if (id !== null && !itemExists.get(id, ctx.categoryId)) id = null; // the list changed since the index was read
		if (id !== null) return { id, created: false };
		const url = `https://www.last.fm/music/${encodeURIComponent(a.artist)}/${encodeURIComponent(a.title)}`;
		const at = (a.lastUts ?? Math.floor(now / 1000)) * 1000;
		const made = insertItem.get({
			owner: ctx.ownerId,
			category: ctx.categoryId,
			title: a.title,
			subtitle: a.artist,
			pid,
			url,
			metadata: JSON.stringify({
				artist: a.artist,
				genres: [],
				facts: [{ label: 'Artist', value: a.artist }],
				url,
				imageUrl: a.imageUrl,
				enriched: false
			}),
			at
		}) as { id: number } | undefined;
		if (made) {
			if (a.imageUrl) {
				const img = insertCover.get(ctx.ownerId, made.id, a.imageUrl, now) as { id: number };
				setCover.run(img.id, made.id);
			}
			reindexItem(made.id);
			indexAdd(ixs, {
				id: made.id,
				title: a.title,
				subtitle: a.artist,
				metadata: { artist: a.artist },
				provider: 'lastfm',
				providerKind: 'album',
				providerId: pid
			});
			return { id: made.id, created: true };
		}
		// The owner already has this album from last.fm in another list: share it if the person can see that list
		const other = byProviderId.get(ctx.ownerId, pid) as { id: number; categoryId: number } | undefined;
		if (other && canEdit(userId, other.categoryId)) return { id: other.id, created: false };
		return null;
	};

	for (const [albumId, days] of work) {
		let a = getAlbum.get(albumId) as AlbumRow | undefined;
		if (!a) continue;
		if (a.itemId === null && a.linkedAt === null) {
			const hit = resolve(a);
			if (hit) {
				link.run(hit.id, now, hit.created ? 1 : 0, albumId);
				a = getAlbum.get(albumId) as AlbumRow;
			}
		}
		if (a.itemId === null) continue;
		const itemId = a.itemId;

		// An item on a list the person can no longer edit (unshared, or downgraded to view) only keeps the plays
		const it = itemRow.get(itemId) as
			{ ownerId: number; categoryId: number; status: string | null; updatedAt: number } | undefined;
		if (!it || !canEdit(userId, it.categoryId)) continue;

		// One log per listening day
		const upToDate = (date: string, n: number, last: number) =>
			upsertLog.run(
				itemId,
				userId,
				date,
				JSON.stringify({ lastfm: { plays: n } }),
				`${albumId}:${date}`,
				last * 1000
			);
		if (days === 'all') {
			for (const d of datesOf.all(albumId) as { date: string; n: number; last: number }[])
				upToDate(d.date, d.n, d.last);
		} else {
			for (const date of days) {
				const d = dayOf.get(albumId, date) as { n: number; last: number | null };
				if (d.n > 0) upToDate(date, d.n, d.last!);
			}
		}

		// The person's own progress: done when it had none or was only planned
		const mineOnItem = it.ownerId === userId;
		const prev = mineOnItem
			? { status: it.status, updatedAt: it.updatedAt }
			: ((progressRow.get(itemId, userId) as { status: string | null; updatedAt: number } | undefined) ?? {
					status: null,
					updatedAt: 0
				});
		const rules = rulesFor(it.categoryId);
		let status = prev.status;
		if (rules.doneKey && (!status || rules.planned.has(status))) status = rules.doneKey;
		if (status !== prev.status && !a.promoted) markPromoted.run(prev.status, albumId);
		const updated = Math.max(prev.updatedAt, (a.lastUts ?? 0) * 1000);
		const logged = (lastLogged.get(itemId, userId) as { d: string | null }).d;
		if (mineOnItem) setOwner.run(status, logged, updated, itemId);
		else setOther.run(itemId, userId, status, logged, updated);
	}
}

/**
 * The album row for a play: by album mbid, else by artist + title. `find` only looks (nothing is written);
 * `create` adds the row for an album that has none yet. The caller touches an existing row (`fill`) or
 * keeps a new one only once the play itself was stored, so a play that is already known never leaves
 * an album with no plays behind.
 */
function albumFinder(userId: number, username: string) {
	const sqlite = rawDb();
	const byMbid = sqlite.prepare(
		'SELECT id, mbid, image_url AS imageUrl FROM lastfm_albums WHERE user_id = ? AND mbid = ? LIMIT 1'
	);
	const byKey = sqlite.prepare(
		'SELECT id, mbid, image_url AS imageUrl FROM lastfm_albums WHERE user_id = ? AND key = ?'
	);
	const insert = sqlite.prepare(
		'INSERT INTO lastfm_albums (user_id, username, key, artist, title, mbid, image_url) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
	);
	const setImage = sqlite.prepare('UPDATE lastfm_albums SET image_url = ? WHERE id = ?');
	const setMbid = sqlite.prepare('UPDATE lastfm_albums SET mbid = ? WHERE id = ?');
	const setName = sqlite.prepare('UPDATE lastfm_albums SET username = ? WHERE id = ? AND username IS NULL');
	const drop = sqlite.prepare('DELETE FROM lastfm_albums WHERE id = ?');
	type Known = { id: number; mbid: string | null; imageUrl: string | null };
	const seen = new Map<string, Known>();
	const memoKey = (p: Scrobble) => (p.albumMbid ? `m:${p.albumMbid}` : `k:${albumKey(p.artist, p.album)}`);
	return {
		find(p: Scrobble): Known | null {
			const hit = seen.get(memoKey(p));
			if (hit) return hit;
			const m = p.albumMbid ? (byMbid.get(userId, p.albumMbid) as Known | undefined) : undefined;
			const found = m ?? (byKey.get(userId, albumKey(p.artist, p.album)) as Known | undefined);
			if (found) seen.set(memoKey(p), found);
			return found ?? null;
		},
		/** The play was stored: fill in what the row lacks */
		fill(row: Known, p: Scrobble) {
			if (!row.imageUrl && p.imageUrl) {
				setImage.run(p.imageUrl, row.id);
				row.imageUrl = p.imageUrl;
			}
			if (!row.mbid && p.albumMbid) {
				setMbid.run(p.albumMbid, row.id);
				row.mbid = p.albumMbid;
			}
			setName.run(username, row.id);
		},
		create(p: Scrobble): Known {
			const row: Known = {
				id: (
					insert.get(
						userId,
						username,
						albumKey(p.artist, p.album),
						p.artist,
						p.album,
						p.albumMbid,
						p.imageUrl
					) as {
						id: number;
					}
				).id,
				mbid: p.albumMbid,
				imageUrl: p.imageUrl
			};
			seen.set(memoKey(p), row);
			return row;
		},
		/** The play turned out to be stored already: the row made for it has no plays */
		discard(p: Scrobble, row: Known) {
			drop.run(row.id);
			seen.delete(memoKey(p));
		}
	};
}

/**
 * Stores a page of plays and everything they cause, in one transaction together with the window
 * cursor. Plays already stored are ignored (the primary key), so re-running a window is harmless.
 * Plays without an album are skipped.
 */
export function applyScrobbles(
	userId: number,
	plays: Scrobble[],
	cursor: CursorPatch = {},
	run?: RunCache
): { inserted: number } {
	const sqlite = rawDb();
	return sqlite.transaction(() => {
		const a = accountRow(userId);
		if (!a) return { inserted: 0 };
		const now = Date.now();
		const { ctx, error } = resolveList(a);

		const albums = albumFinder(userId, a.username);
		const insertPlay = sqlite.prepare(
			'INSERT OR IGNORE INTO lastfm_scrobbles (user_id, uts, track_key, album_id, date, track) VALUES (?, ?, ?, ?, ?, ?)'
		);
		// A play seen again fills in the name it lacks; one that has a name keeps it. Counts never change.
		const nameIt = sqlite.prepare(
			'UPDATE lastfm_scrobbles SET track = ? WHERE user_id = ? AND uts = ? AND track_key = ? AND track IS NULL'
		);
		const work: Work = new Map();
		let inserted = 0;
		for (const p of plays) {
			if (!p.album || !p.artist) continue;
			const date = localDay(p.uts * 1000);
			const trackKey = `${foldName(p.artist)}|${foldName(p.track)}`;
			const name = p.track.trim() || null;
			const known = albums.find(p);
			const row = known ?? albums.create(p);
			const albumId = row.id;
			const r = insertPlay.run(userId, p.uts, trackKey, albumId, date, name);
			if (!r.changes) {
				if (name) nameIt.run(name, userId, p.uts, trackKey);
				// Already stored (an overlap re-read, maybe under another album name): leave no empty album behind
				if (!known) albums.discard(p, row);
				continue;
			}
			if (known) albums.fill(row, p);
			inserted++;
			const days = work.get(albumId);
			if (days instanceof Set) days.add(date);
			else work.set(albumId, new Set([date]));
		}
		if (ctx) linkAndWrite(userId, ctx, work, run);
		else recountAlbums(work.keys());

		// The cursor, the status and the errors
		const set: Partial<typeof schema.lastfmAccounts.$inferInsert> = {
			errorCode: error ? 'list' : null,
			errorMessage: error ?? null,
			errorCount: 0
		};
		if (cursor.jobTo !== undefined) set.jobTo = cursor.jobTo;
		if (cursor.jobTotal !== undefined) set.jobTotal = cursor.jobTotal;
		if (cursor.addDone) set.jobDone = a.jobDone + cursor.addDone;
		if (!error) set.nextSyncAt = a.job ? 0 : a.nextSyncAt;
		if (cursor.finish && a.job === 'names') {
			// The one-time name re-read: nothing about the history itself changes, only that it is done
			Object.assign(set, {
				namesAt: now,
				job: null,
				jobFrom: null,
				jobTo: null,
				jobEnd: null,
				jobTotal: null,
				jobDone: 0,
				nextSyncAt: 0
			});
		} else if (cursor.finish) {
			const totals = sqlite
				.prepare(
					`SELECT (SELECT COUNT(*) FROM lastfm_scrobbles WHERE user_id = @u) AS plays,
						(SELECT COUNT(*) FROM lastfm_albums WHERE user_id = @u) AS albums`
				)
				.get({ u: userId }) as { plays: number; albums: number };
			Object.assign(set, {
				syncedUntil: a.jobEnd ?? a.syncedUntil,
				backfilledAt: a.job === 'backfill' ? new Date(now) : a.backfilledAt,
				// The first full import has just read everything, so the next deep re-read is a day away
				...(a.job === 'backfill' ? { deepSyncAt: now } : {}),
				job: null,
				jobFrom: null,
				jobTo: null,
				jobEnd: null,
				jobTotal: null,
				jobDone: 0,
				lastSyncAt: new Date(now),
				nextSyncAt: now + (a.syncEvery === 'daily' ? DAY : HOUR),
				plays: totals.plays,
				albums: totals.albums,
				// A backfill that began before names were kept still has unnamed plays: the names job reads them
				...(a.job === 'backfill' ? { namesAt: hasUnnamedPlays(userId) ? null : now } : {})
			});
		}
		db().update(schema.lastfmAccounts).set(set).where(eq(schema.lastfmAccounts.userId, userId)).run();
		return { inserted };
	})();
}

/**
 * Albums with plays that have no item yet because there was no list to put them in, or that the person
 * asked to get back: placed now, with logs for every day they were played.
 */
function relinkPending(userId: number, run?: RunCache): number {
	const a = accountRow(userId);
	if (!a) return 0;
	// Albums without a single play (left by older versions) are not albums
	rawDb()
		.prepare(
			`DELETE FROM lastfm_albums WHERE user_id = ? AND item_id IS NULL
			 AND NOT EXISTS (SELECT 1 FROM lastfm_scrobbles s WHERE s.album_id = lastfm_albums.id)`
		)
		.run(userId);
	const { ctx } = resolveList(a);
	if (!ctx) return 0;
	const rows = rawDb()
		.prepare(
			'SELECT id FROM lastfm_albums WHERE user_id = ? AND item_id IS NULL AND linked_at IS NULL AND plays > 0'
		)
		.all(userId) as { id: number }[];
	if (!rows.length) return 0;
	const work: Work = new Map(rows.map((r) => [r.id, 'all' as const]));
	rawDb().transaction(() => linkAndWrite(userId, ctx, work, run))();
	return rows.length;
}

// --- Connecting -----------------------------------------------------------------------------

/** The last.fm name listening was imported from, when some is still stored; null when nothing is */
function importedFrom(userId: number, current?: string): string | null {
	const sqlite = rawDb();
	const any = sqlite.prepare('SELECT 1 FROM lastfm_albums WHERE user_id = ? LIMIT 1').get(userId);
	if (!any) return null;
	if (current) return current;
	const named = sqlite
		.prepare('SELECT username FROM lastfm_albums WHERE user_id = ? AND username IS NOT NULL LIMIT 1')
		.get(userId) as { username: string } | undefined;
	return named?.username ?? null;
}

/** Some listening is stored (the page then offers to delete it, also with no account) */
export function hasImportedListening(userId: number): boolean {
	return !!rawDb().prepare('SELECT 1 FROM lastfm_albums WHERE user_id = ? LIMIT 1').get(userId);
}

const USERNAME = /^[A-Za-z][\w-]{1,14}$/;

function startBackfill(userId: number) {
	const nowS = Math.floor(Date.now() / 1000);
	db()
		.update(schema.lastfmAccounts)
		.set({
			job: 'backfill',
			jobFrom: 0,
			jobTo: nowS,
			jobEnd: nowS,
			jobTotal: null,
			jobDone: 0,
			nextSyncAt: 0,
			errorCode: null,
			errorMessage: null,
			errorCount: 0
		})
		.where(eq(schema.lastfmAccounts.userId, userId))
		.run();
}

/** Some stored play has no readable track name yet (stored before names were kept) */
function hasUnnamedPlays(userId: number): boolean {
	return !!rawDb()
		.prepare('SELECT 1 FROM lastfm_scrobbles WHERE user_id = ? AND track IS NULL LIMIT 1')
		.get(userId);
}

/** The one-time re-read of the whole history that fills in track names (a window job like a backfill) */
function startNames(userId: number) {
	const nowS = Math.floor(Date.now() / 1000);
	db()
		.update(schema.lastfmAccounts)
		.set({ job: 'names', jobFrom: 0, jobTo: nowS, jobEnd: nowS, jobTotal: null, jobDone: 0, nextSyncAt: 0 })
		.where(eq(schema.lastfmAccounts.userId, userId))
		.run();
}

/** Makes sure an owned list can hold albums from last.fm */
function allowAlbumKind(userId: number, categoryId: number) {
	const c = rawDb()
		.prepare('SELECT user_id AS ownerId, provider_kinds AS kinds FROM categories WHERE id = ?')
		.get(categoryId) as { ownerId: number; kinds: string } | undefined;
	if (!c || c.ownerId !== userId) return;
	const kinds = JSON.parse(c.kinds) as string[];
	if (kinds.includes('lastfm:album')) return;
	db()
		.update(schema.categories)
		.set({ providerKinds: [...kinds, 'lastfm:album'] })
		.where(eq(schema.categories.id, categoryId))
		.run();
}

function pickableList(userId: number, categoryId: number) {
	if (!lastfmTargetLists(userId).some((l) => l.id === categoryId)) {
		throw new LastfmUserError("You can't add albums to that list.", 'list');
	}
}

/**
 * Checks the username (and that its history is public), then starts importing it. `categoryId`: the
 * list to put albums in, or 'new' for a fresh "Music" list. Connecting again replaces the old account:
 * the same history never doubles, as a play is identified by who, when and which track.
 */
export async function connectLastfm(
	userId: number,
	input: { username: string; categoryId: number | 'new' },
	signal?: AbortSignal
): Promise<LastfmAccountView> {
	if (!keys().lastfmKey) throw new LastfmUserError(NOT_SET_UP, 'setup');
	const typed = input.username.trim();
	if (!USERNAME.test(typed)) throw new LastfmUserError(`There's no last.fm user called '${typed}'.`, 'user');
	if (input.categoryId !== 'new') pickableList(userId, input.categoryId);

	let name: string;
	try {
		name = (await getUserInfo(typed, signal)).name;
		await getRecentTracks(name, { limit: 1 }, signal);
	} catch (e) {
		if (e instanceof LastfmError) {
			if (e.code === 'notfound')
				throw new LastfmUserError(`There's no last.fm user called '${typed}'.`, 'user');
			if (e.code === 'private') {
				throw new LastfmUserError(
					`${typed}'s listening history is private on last.fm. On last.fm open Settings → Privacy, untick 'Hide recent listening', then try again.`,
					'private'
				);
			}
			if (e.code === 'auth') throw new LastfmUserError(NOT_SET_UP, 'setup');
			throw new LastfmUserError("Couldn't reach last.fm. Try again in a minute.", 'other');
		}
		throw e;
	}

	const existing = accountRow(userId);
	const same = existing && existing.username.toLowerCase() === name.toLowerCase();
	// Names can't be changed on last.fm, so a different one is a different person: their plays would merge with these
	const imported = importedFrom(userId, existing?.username);
	if (imported && imported.toLowerCase() !== name.toLowerCase()) {
		throw new LastfmUserError(
			`You've imported listening from ${imported}. To connect ${name} instead, first delete the imported listening below.`,
			'user'
		);
	}
	const id = input.categoryId === 'new' ? createCategoryFromTemplate(userId, 'albums').id : input.categoryId;
	allowAlbumKind(userId, id);
	const values = {
		userId,
		username: name,
		categoryId: id,
		errorCode: null,
		errorMessage: null,
		errorCount: 0,
		nextSyncAt: 0
	};
	if (existing && same) {
		db().update(schema.lastfmAccounts).set(values).where(eq(schema.lastfmAccounts.userId, userId)).run();
	} else {
		db().delete(schema.lastfmAccounts).where(eq(schema.lastfmAccounts.userId, userId)).run();
		db().insert(schema.lastfmAccounts).values(values).run();
	}
	// A new account, or one that never finished its first import, starts from the beginning
	const fresh = accountRow(userId)!;
	if (!fresh.backfilledAt && !fresh.job) startBackfill(userId);
	kickLastfm();
	return getLastfmAccount(userId)!;
}

export function updateLastfmSettings(
	userId: number,
	patch: { categoryId?: number; syncEvery?: 'hourly' | 'daily'; journalMode?: 'group' | 'hide' | 'all' }
): LastfmAccountView {
	const a = accountRow(userId);
	if (!a) throw new LastfmUserError("last.fm isn't connected.", 'other');
	const set: Partial<typeof schema.lastfmAccounts.$inferInsert> = {};
	if (patch.syncEvery === 'hourly' || patch.syncEvery === 'daily') set.syncEvery = patch.syncEvery;
	if (patch.journalMode === 'group' || patch.journalMode === 'hide' || patch.journalMode === 'all') {
		set.journalMode = patch.journalMode;
	}
	if (patch.categoryId !== undefined && (patch.categoryId !== a.categoryId || a.errorCode === 'list')) {
		pickableList(userId, patch.categoryId);
		allowAlbumKind(userId, patch.categoryId);
		set.categoryId = patch.categoryId;
		// Plays recorded while there was no list catch up on the next run
		if (a.errorCode === 'list') {
			set.errorCode = null;
			set.errorMessage = null;
		}
		set.nextSyncAt = a.job ? a.nextSyncAt : 0;
	}
	if (Object.keys(set).length) {
		db().update(schema.lastfmAccounts).set(set).where(eq(schema.lastfmAccounts.userId, userId)).run();
	}
	if (set.categoryId) {
		relinkPending(userId);
		kickLastfm();
	}
	return getLastfmAccount(userId)!;
}

const lastRequest = new Map<number, number>();

/** "Sync now": not while one runs, and at most once a minute */
export function requestSync(userId: number, now = Date.now()): { started: boolean; reason?: string } {
	const a = accountRow(userId);
	if (!a) return { started: false, reason: "last.fm isn't connected." };
	if (!keys().lastfmKey) return { started: false, reason: NOT_SET_UP };
	if (a.job && !a.errorCode) return { started: false, reason: 'A sync is already running.' };
	if (now - (lastRequest.get(userId) ?? 0) < 60_000) {
		return { started: false, reason: 'Please wait a minute between syncs.' };
	}
	lastRequest.set(userId, now);
	db()
		.update(schema.lastfmAccounts)
		.set({ nextSyncAt: 0, errorCode: null, errorMessage: null, errorCount: 0 })
		.where(eq(schema.lastfmAccounts.userId, userId))
		.run();
	kickLastfm();
	return { started: true };
}

/** Forgets the username and stops syncing. Everything imported so far stays. */
export function disconnectLastfm(userId: number) {
	db().delete(schema.lastfmAccounts).where(eq(schema.lastfmAccounts.userId, userId)).run();
	lastRequest.delete(userId);
}

/**
 * A new API key was saved: accounts that were paused because the old one was rejected start again.
 * Returns how many.
 */
export function resetLastfmAuthErrors(): number {
	const r = rawDb()
		.prepare(
			`UPDATE lastfm_accounts SET error_code = NULL, error_message = NULL, error_count = 0, next_sync_at = 0
			 WHERE error_code = 'auth'`
		)
		.run();
	return r.changes;
}

// --- Removed albums ----------------------------------------------------------------------------

/** Albums the person deleted from their list (a later play doesn't bring them back) */
export function removedAlbumCount(userId: number) {
	return removedCountOf(userId);
}

/** Brings deleted albums back, with logs for every day they were played. Returns how many. */
export function readdRemovedAlbums(userId: number): number {
	const sqlite = rawDb();
	const r = sqlite
		.prepare(
			'UPDATE lastfm_albums SET linked_at = NULL WHERE user_id = ? AND item_id IS NULL AND linked_at IS NOT NULL'
		)
		.run(userId);
	if (!r.changes) return 0;
	const n = relinkPending(userId);
	if (!n) {
		// No list to put them in right now: they come back once one is picked
		db()
			.update(schema.lastfmAccounts)
			.set({ nextSyncAt: 0 })
			.where(eq(schema.lastfmAccounts.userId, userId))
			.run();
	}
	return r.changes;
}

// --- Deleting what was imported ---------------------------------------------------------------------

export interface DeleteResult {
	/** Listening logs removed */
	logs: number;
	/** Albums the import added that nobody had touched, now removed */
	items: number;
	/** Albums that got back the status they had before */
	restored: number;
}

class Rollback extends Error {
	constructor(public result: DeleteResult) {
		super('rollback');
	}
}

function deleteImported(userId: number): DeleteResult {
	const sqlite = rawDb();
	const logIds = (
		sqlite
			.prepare("SELECT DISTINCT item_id AS id FROM item_logs WHERE user_id = ? AND source = 'lastfm'")
			.all(userId) as {
			id: number;
		}[]
	).map((r) => r.id);
	const logs = sqlite
		.prepare("DELETE FROM item_logs WHERE user_id = ? AND source = 'lastfm'")
		.run(userId).changes;

	const albums = sqlite
		.prepare(`SELECT ${ALBUM_COLS} FROM lastfm_albums WHERE user_id = ? AND item_id IS NOT NULL`)
		.all(userId) as AlbumRow[];

	// Statuses the import moved to done go back to what they were, if they're still that
	let restored = 0;
	const itemOf = sqlite.prepare(
		'SELECT user_id AS ownerId, category_id AS categoryId, status FROM items WHERE id = ?'
	);
	const progressOf = sqlite.prepare('SELECT status FROM item_progress WHERE item_id = ? AND user_id = ?');
	const statusesOf = sqlite.prepare('SELECT statuses FROM categories WHERE id = ?');
	const setOwner = sqlite.prepare('UPDATE items SET status = ? WHERE id = ?');
	const setOther = sqlite.prepare('UPDATE item_progress SET status = ? WHERE item_id = ? AND user_id = ?');
	for (const a of albums) {
		if (!a.promoted) continue;
		const it = itemOf.get(a.itemId!) as
			{ ownerId: number; categoryId: number; status: string | null } | undefined;
		if (!it) continue;
		const mineOnItem = it.ownerId === userId;
		const current = mineOnItem
			? it.status
			: ((progressOf.get(a.itemId!, userId) as { status: string | null } | undefined)?.status ?? null);
		const done = doneKeyOf(JSON.parse((statusesOf.get(it.categoryId) as { statuses: string }).statuses));
		if (!done || current !== done) continue;
		if (mineOnItem) setOwner.run(a.statusBefore, a.itemId);
		else setOther.run(a.statusBefore, a.itemId, userId);
		// Only albums that were already there count as restored; ones the import created are just emptied
		if (!a.createdItem) restored++;
	}

	// Albums the import added that nobody has touched since: still as the import (and the details fill-in)
	// left them, so anything edited by hand is kept
	const untouched = sqlite.prepare(
		`SELECT 1 FROM items i WHERE i.id = @id
			AND i.title = @title AND i.subtitle IS @artist AND i.external_url IS @url
			AND (i.description IS NULL OR i.description = json_extract(i.metadata, '$.importedDescription'))
			AND i.barcode IS NULL AND i.custom IN ('{}', '')
			AND i.status IS NULL AND i.rating IS NULL AND i.favorite = 0 AND i.notes IS NULL
			AND NOT EXISTS (SELECT 1 FROM item_logs WHERE item_id = i.id)
			AND NOT EXISTS (SELECT 1 FROM item_progress p WHERE p.item_id = i.id
				AND (p.status IS NOT NULL OR p.rating IS NOT NULL OR p.favorite = 1 OR p.notes IS NOT NULL))
			AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_id = i.id)
			AND NOT EXISTS (SELECT 1 FROM images im WHERE im.item_id = i.id
				AND (im.kind != 'url_link' OR im.id IS NOT i.cover_image_id))
			AND NOT EXISTS (SELECT 1 FROM episode_watches WHERE item_id = i.id)
			AND NOT EXISTS (SELECT 1 FROM lastfm_albums o WHERE o.item_id = i.id AND o.user_id != @user)`
	);
	const drop = sqlite.prepare('DELETE FROM items WHERE id = ?');
	const gone = new Set<number>();
	for (const a of albums) {
		if (!a.createdItem || gone.has(a.itemId!)) continue;
		const url = `https://www.last.fm/music/${encodeURIComponent(a.artist)}/${encodeURIComponent(a.title)}`;
		if (untouched.get({ id: a.itemId, user: userId, title: a.title, artist: a.artist, url })) {
			drop.run(a.itemId);
			gone.add(a.itemId!);
		}
	}

	sqlite.prepare('DELETE FROM lastfm_albums WHERE user_id = ?').run(userId);
	sqlite.prepare('DELETE FROM lastfm_accounts WHERE user_id = ?').run(userId);
	for (const id of new Set(logIds)) if (!gone.has(id)) refreshLastLogged(id, userId);
	return { logs, items: gone.size, restored };
}

/** What deleteImportedListening would remove, without changing anything */
export function previewDeleteImported(userId: number): DeleteResult {
	try {
		rawDb().transaction(() => {
			throw new Rollback(deleteImported(userId));
		})();
	} catch (e) {
		if (e instanceof Rollback) return e.result;
		throw e;
	}
	return { logs: 0, items: 0, restored: 0 };
}

/**
 * Removes the listening logs this person imported, gives back the statuses the import changed, removes
 * the albums the import added that nobody has touched, and disconnects.
 */
export function deleteImportedListening(userId: number): DeleteResult {
	const result = rawDb().transaction(() => deleteImported(userId))();
	lastRequest.delete(userId);
	return result;
}

// --- Reading the history ------------------------------------------------------------------------

/** Retry delay after a failed call, per last.fm's error: see the table in the design */
export function retryDelay(code: string, errorCount: number): number | null {
	const n = Math.max(0, errorCount - 1);
	switch (code) {
		case 'auth':
		case 'notfound':
			return null; // paused until the key is saved again / the person reconnects
		case 'private':
			return DAY;
		case 'rate':
			return Math.min(HOUR, 5 * 60_000 * 2 ** n);
		default:
			return Math.min(HOUR, 60_000 * 2 ** n);
	}
}

function recordError(userId: number, e: unknown) {
	const a = accountRow(userId);
	if (!a) return;
	const code = e instanceof LastfmError ? e.code : 'other';
	const count = a.errorCount + 1;
	const delay = retryDelay(code, count);
	db()
		.update(schema.lastfmAccounts)
		.set({
			errorCode: code,
			errorMessage: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
			errorCount: count,
			nextSyncAt: delay === null ? Date.now() + DAY : Date.now() + delay
		})
		.where(eq(schema.lastfmAccounts.userId, userId))
		.run();
	if (!(e instanceof LastfmError)) console.error('[lastfm] sync failed', e);
}

/** An error that stops the account until something changes: the key, or the username */
const isPaused = (a: AccountRow) => a.errorCode === 'auth' || a.errorCode === 'notfound';

/**
 * One request of an account's history: starts the window job if none runs, reads one page, stores it.
 * 'more': call again; 'done': the window just finished; 'idle': nothing to do now (or it failed and is
 * waiting to retry).
 */
export async function runPage(
	userId: number,
	signal?: AbortSignal,
	run?: RunCache
): Promise<'more' | 'done' | 'idle'> {
	let a = accountRow(userId);
	if (!a || isPaused(a)) return 'idle';
	const now = Date.now();
	if (a.nextSyncAt > now) return 'idle';
	if (!keys().lastfmKey) return 'idle';

	// The list works again (shared again, or picked): plays recorded without one get their albums now
	if (a.errorCode === 'list') relinkPending(userId, run);

	if (!a.job) {
		// Albums waiting for a list (or brought back) are placed before reading more
		relinkPending(userId, run);
		if (!a.backfilledAt) {
			startBackfill(userId);
		} else if (a.namesAt === null && hasUnnamedPlays(userId)) {
			startNames(userId);
		} else {
			if (a.namesAt === null) {
				// Nothing to fill in (or nothing stored): there is no names job to run, ever
				db()
					.update(schema.lastfmAccounts)
					.set({ namesAt: now })
					.where(eq(schema.lastfmAccounts.userId, userId))
					.run();
			}
			const nowS = Math.floor(now / 1000);
			const deep = now - a.deepSyncAt >= DAY;
			const jobFrom = Math.max(0, a.syncedUntil - (deep ? DEEP_OVERLAP_S : OVERLAP_S));
			db()
				.update(schema.lastfmAccounts)
				.set({
					job: 'sync',
					jobFrom,
					jobTo: nowS,
					jobEnd: nowS,
					jobTotal: null,
					jobDone: 0,
					...(deep ? { deepSyncAt: now } : {})
				})
				.where(eq(schema.lastfmAccounts.userId, userId))
				.run();
		}
		a = accountRow(userId)!;
	}

	const jobFrom = a.jobFrom ?? 0;
	const jobTo = a.jobTo ?? 0;
	const from = jobFrom + 1;
	// The window is empty (its end moved below its start): there is nothing left to read
	if (jobTo < from) {
		try {
			applyScrobbles(userId, [], { finish: true }, run);
		} catch (e) {
			recordError(userId, e);
			return 'idle';
		}
		return 'done';
	}

	let page: Awaited<ReturnType<typeof getRecentTracks>>;
	const plays: Scrobble[] = [];
	let last: Scrobble[];
	try {
		const ask = (n: number) =>
			getRecentTracks(
				a.username,
				{ from: jobFrom ? from : undefined, to: jobTo, limit: PAGE, page: n },
				signal
			);
		page = await ask(1);
		plays.push(...page.plays);
		last = page.plays;
		// A full page that is all one second (the cursor's) hides more plays of that second behind it:
		// moving the cursor below it would lose them, so read on through the same window first
		for (let n = 2; n <= MAX_SAME_SECOND_PAGES && isOneSecond(last, jobTo); n++) {
			last = (await ask(n)).plays;
			plays.push(...last);
		}
	} catch (e) {
		if (signal?.aborted) return 'idle';
		recordError(userId, e);
		return 'idle';
	}

	const minUts = plays.length ? Math.min(...plays.map((p) => p.uts)) : null;
	const finished = minUts === null || minUts <= jobFrom || last.length < FULL_PAGE;
	const cursor: CursorPatch = {
		addDone: plays.length,
		jobTo: minUts === null ? jobTo : minUts < jobTo ? minUts : jobTo - 1,
		finish: finished
	};
	if (a.jobTotal === null) cursor.jobTotal = page.total;
	try {
		applyScrobbles(userId, plays, cursor, run);
	} catch (e) {
		recordError(userId, e);
		return 'idle';
	}
	return finished ? 'done' : 'more';
}

// --- In the background ---------------------------------------------------------------------------

const TICK_FIRST_MS = 30_000;
const TICK_EVERY_MS = 60_000;
const TICK_BUDGET_MS = 50_000;

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let again = false;

/** Accounts whose turn it is: a job that can continue, or a sync that is due */
function dueAccounts(now: number): number[] {
	return (
		rawDb()
			.prepare(
				`SELECT user_id AS id FROM lastfm_accounts
				 WHERE next_sync_at <= ? AND (error_code IS NULL OR error_code NOT IN ('auth', 'notfound'))
				 ORDER BY next_sync_at, user_id`
			)
			.all(now) as { id: number }[]
	).map((r) => r.id);
}

/** A full page whose plays all happened in the second `uts` */
const isOneSecond = (page: Scrobble[], uts: number) =>
	page.length >= FULL_PAGE && page.every((p) => p.uts === uts);

/** Safety stop for one second with an absurd number of plays (200 each) */
const MAX_SAME_SECOND_PAGES = 100;

/** True while some account still has a window job running that can make progress */
export function backfillsRunning(now: number) {
	if (!keys().lastfmKey) return false; // nothing can run without the key
	return !!rawDb()
		.prepare(
			`SELECT 1 FROM lastfm_accounts WHERE (job IS NOT NULL OR backfilled_at IS NULL)
			 AND (error_code IS NULL OR error_code NOT IN ('auth', 'notfound')) AND next_sync_at <= ?`
		)
		.get(now);
}

/** One scheduler pass: reads history for due accounts, then does idle work */
export async function lastfmTick(budgetMs = TICK_BUDGET_MS): Promise<void> {
	if (!keys().lastfmKey) return;
	const deadline = Date.now() + budgetMs;
	const signal = AbortSignal.timeout(budgetMs + 5_000);
	for (const id of dueAccounts(Date.now())) {
		const run = newRunCache();
		while (Date.now() < deadline && !signal.aborted) {
			const r = await runPage(id, signal, run);
			if (r !== 'more') break;
			// A page is one synchronous transaction (about 100 ms here, several times that on a slow NAS):
			// let the requests that queued up meanwhile run before the next one starts
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	// Once every backfill is idle, the slow details fill-in uses what is left of the budget
	if (!backfillsRunning(Date.now())) await idleWork(deadline, signal);
}

const ENRICH_EVERY_MS = 2_000;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});

/** Work for when no history is being read: the details fill-in, about one album every 2 s */
async function idleWork(deadline: number, signal: AbortSignal): Promise<void> {
	// Details first; once none are pending, tracklists for albums that were filled in before they were kept
	while (
		Date.now() < deadline &&
		!signal.aborted &&
		((await enrichNext(signal)) || (await tracklistNext(signal)))
	) {
		if (Date.now() + ENRICH_EVERY_MS >= deadline) break;
		await sleep(ENRICH_EVERY_MS, signal);
	}
}

// --- Filling in album details ------------------------------------------------------------------------

/** Failures that say "try later" rather than "this album can't be looked up" */
const TEMPORARY = new Set(['auth', 'rate', 'unreachable', 'private']);

/**
 * Fills in one imported album's details from last.fm (genres, description, facts, a cover when it has
 * none) and marks it done. An album last.fm doesn't know is marked done too, so it isn't asked for again;
 * a temporary failure leaves it for a later pass. Returns true when it handled an album (call again),
 * false when there is nothing left or last.fm can't be reached right now.
 */
export async function enrichNext(signal?: AbortSignal): Promise<boolean> {
	const sqlite = rawDb();
	const row = sqlite
		.prepare(
			`SELECT id, user_id AS ownerId, provider_id AS pid, description, cover_image_id AS cover, metadata
			 FROM items WHERE provider = 'lastfm' AND provider_kind = 'album'
			 AND json_extract(metadata, '$.enriched') = 0 ORDER BY id LIMIT 1`
		)
		.get() as
		| {
				id: number;
				ownerId: number;
				pid: string;
				description: string | null;
				cover: number | null;
				metadata: string;
		  }
		| undefined;
	if (!row) {
		sqlite
			.prepare(
				'UPDATE lastfm_accounts SET enriched_at = ? WHERE enriched_at IS NULL AND backfilled_at IS NOT NULL'
			)
			.run(Date.now());
		return false;
	}
	const meta = JSON.parse(row.metadata) as {
		genres?: string[];
		facts?: { label: string; value: string }[];
		imageUrl?: string | null;
		url?: string | null;
		tracks?: unknown;
		[k: string]: unknown;
	};

	let d: Awaited<ReturnType<typeof lastfm.details>> | null = null;
	try {
		d = await lastfm.details('album', row.pid, signal);
	} catch (e) {
		if (signal?.aborted || (e instanceof ProviderError && TEMPORARY.has(e.code))) return false;
		// last.fm doesn't know this album (or never will), or its answer can't be read: it is done, so it
		// isn't asked for again and the queue moves on
		if (!(e instanceof ProviderError)) console.warn(`[lastfm] details for item ${row.id} failed`, e);
	}

	sqlite.transaction(() => {
		if (!d) {
			sqlite
				.prepare(
					`UPDATE items SET metadata = json_set(metadata, '$.enriched', json('true'),
						'$.tracks', json(COALESCE(json_extract(metadata, '$.tracks'), '[]'))) WHERE id = ?`
				)
				.run(row.id);
			return;
		}
		const genres = [...new Set([...(meta.genres ?? []), ...(d.genres ?? [])])];
		const facts = [...(meta.facts ?? [])];
		for (const f of d.facts) if (!facts.some((x) => x.label === f.label)) facts.push(f);
		const art = d.largeImageUrl ?? d.imageUrl ?? null;
		const description = row.description || d.description || null;
		sqlite.prepare('UPDATE items SET metadata = ?, description = ? WHERE id = ?').run(
			JSON.stringify({
				...meta,
				// What the fill-in wrote, so deleting the import can tell it from a description typed by hand
				...(!row.description && d.description ? { importedDescription: d.description } : {}),
				genres,
				facts,
				imageUrl: meta.imageUrl ?? art,
				// A tracklist that is already there stays
				tracks: meta.tracks ?? d.tracks ?? [],
				url: meta.url ?? d.url ?? null,
				enriched: true,
				fetchedAt: new Date().toISOString()
			}),
			description,
			row.id
		);
		if (!row.cover && art) {
			const img = sqlite
				.prepare(
					`INSERT INTO images (user_id, item_id, kind, source_url, sort_order, created_at)
					 VALUES (?, ?, 'url_link', ?, 0, ?) RETURNING id`
				)
				.get(row.ownerId, row.id, art, Date.now()) as { id: number };
			sqlite.prepare('UPDATE items SET cover_image_id = ? WHERE id = ?').run(img.id, row.id);
		}
	})();
	reindexItem(row.id);
	return true;
}
/**
 * The low-priority pass after the details: albums that were filled in (or added from search) before
 * tracklists were kept get theirs. Only the tracklist is written, so nothing else on the item is touched
 * and a tracklist that appeared meanwhile is never overwritten. An album last.fm can't give a tracklist
 * for gets an empty one, so it isn't asked for again. Returns true when it handled an album.
 */
export async function tracklistNext(signal?: AbortSignal): Promise<boolean> {
	const sqlite = rawDb();
	const row = sqlite
		.prepare(
			`SELECT id, provider_id AS pid FROM items
			 WHERE provider = 'lastfm' AND provider_kind = 'album' AND json_extract(metadata, '$.enriched') = 1
			 AND json_extract(metadata, '$.tracks') IS NULL ORDER BY id LIMIT 1`
		)
		.get() as { id: number; pid: string } | undefined;
	if (!row) return false;
	let tracks: AlbumTrack[] = [];
	try {
		tracks = (await lastfm.details('album', row.pid, signal)).tracks ?? [];
	} catch (e) {
		if (signal?.aborted || (e instanceof ProviderError && TEMPORARY.has(e.code))) return false;
		if (!(e instanceof ProviderError)) console.warn(`[lastfm] tracklist for item ${row.id} failed`, e);
	}
	sqlite
		.prepare(
			`UPDATE items SET metadata = json_set(metadata, '$.tracks', json(?))
			 WHERE id = ? AND json_extract(metadata, '$.tracks') IS NULL`
		)
		.run(JSON.stringify(tracks), row.id);
	return true;
}

async function tick() {
	if (busy) {
		again = true;
		return;
	}
	busy = true;
	try {
		do {
			again = false;
			await lastfmTick();
		} while (again);
	} catch (e) {
		console.error('[lastfm] tick failed', e);
	} finally {
		busy = false;
	}
	// An import that outlasted the budget carries on right away rather than waiting for the next minute
	try {
		if (backfillsRunning(Date.now())) setTimeout(() => void tick(), 1_000).unref();
	} catch {
		/* the database may be closing */
	}
}

/** Starts the scheduler: first pass after 30 s, then every minute */
export function startLastfmScheduler() {
	if (timer) return;
	setTimeout(() => void tick(), TICK_FIRST_MS).unref();
	timer = setInterval(() => void tick(), TICK_EVERY_MS);
	timer.unref();
}

/** Runs a pass now (after connecting, "Sync now" or saving the API key), unless one is running */
export function kickLastfm() {
	if (!timer) return; // the scheduler isn't running (tests, scripts)
	setTimeout(() => void tick(), 0).unref();
}
