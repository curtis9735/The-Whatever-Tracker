import { rawDb } from '../db';
import { foldName } from '../providers/artist-images';
import { todayIso } from '../forms';
import { ME, PROGRESS_JOIN, mine } from './access';
import { sharedSlug } from './categories';
import { IN_LISTS, logBounds, visibleLists } from './journal';
import { imageSrc, type ImageRef } from '$lib/images';
import { addDays } from '$lib/journal';
import type { MetadataFact } from '$lib/types';
import { DEFAULT_EPISODE_MINUTES, DEFAULT_MOVIE_MINUTES, runtimeFromFacts } from '$lib/watching';

/*
 * Year in review: one person's own year, read from their logs (on the lists they can still see, exactly
 * as the Journal does), their last.fm scrobbles and their episode watches. Nothing of anyone else's is
 * read. As in the Journal's grouped mode, a day of imported listening counts once however much was
 * played, so tens of thousands of scrobbles can't swamp the counts; the Music section is where plays
 * are counted. Everything is aggregated in SQL (or from a year's few thousand hand-written logs) and the
 * result is plain data that can go straight to the browser.
 */

/** An item with its cover, as a tile */
export interface YearTile {
	itemId: number;
	title: string;
	coverUrl: string | null;
	/** Stored rating (0-100 in tens), when there is one */
	rating: number | null;
	/** How many times it was logged (or watched, or played) */
	count: number;
}

/** One thing logged, named for the highlights */
export interface YearLogRef {
	itemId: number;
	title: string;
	date: string;
	listName: string;
	listIcon: string;
	coverUrl: string | null;
}

export interface YearList {
	id: number;
	name: string;
	icon: string;
	color: string;
	slug: string;
	logs: number;
	/** Different items logged */
	items: number;
	/** Up to 3, best rated first (the best log rating this year, else the item's own rating) */
	topRated: YearTile[];
	/** Up to 5, logged most often first */
	mostLogged: YearTile[];
}

export interface YearWatching {
	/** Movie logs (a rewatch counts again) */
	movies: number;
	/** Episode plays dated in the year */
	episodes: number;
	minutes: number;
	hours: number;
	/** Some length was assumed (a usual movie or episode length) rather than known */
	approximate: boolean;
	/** The show with the most episodes watched */
	topShow: YearTile | null;
	/** Up to 3 movies, best rated first */
	topMovies: YearTile[];
	/** The day with the most movies and episodes */
	busiestDay: { date: string; count: number } | null;
}

export interface YearMusic {
	plays: number;
	tracks: number;
	albums: number;
	artists: number;
	topAlbums: {
		itemId: number | null;
		title: string;
		artist: string;
		plays: number;
		coverUrl: string | null;
	}[];
	topArtists: { artist: string; plays: number; albums: number; coverUrl: string | null }[];
	topTracks: { name: string; artist: string; plays: number; coverUrl: string | null }[];
	biggestDay: { date: string; plays: number };
	/** 1-12 */
	busiestMonth: { month: number; plays: number };
}

export interface YearReview {
	year: number;
	headline: {
		/** Things logged: hand-written logs, plus one for each day of imported listening */
		logged: number;
		activeDays: number;
		lists: number;
		/** Items whose first log ever falls in the year */
		newItems: number;
		/** The year is the current one: it's still going */
		soFar: boolean;
	};
	/** Things logged in each month, January first */
	months: number[];
	highlights: {
		longestStreak: { from: string; to: string; days: number } | null;
		/** 1-12 */
		busiestMonth: { month: number; count: number } | null;
		busiestDay: { date: string; count: number } | null;
		topRated: (YearLogRef & { rating: number }) | null;
		/** Places (log locations) not used on any earlier log */
		newPlaces: number;
		/** Concert artists seen live, and last.fm artists played, for the first time */
		newArtists: number;
		first: YearLogRef | null;
		last: YearLogRef | null;
	};
	lists: YearList[];
	watching: YearWatching | null;
	music: YearMusic | null;
}

const isYear = (y: number) => Number.isInteger(y) && y >= 1000 && y <= 9999;
const bounds = (year: number) => ({ from: `${year}-01-01`, to: `${year}-12-31` });

/** The browser URL of a joined cover image (img_* columns), or null */
function cover(r: {
	img_kind: ImageRef['kind'] | null;
	img_path: string | null;
	img_thumb: string | null;
	img_source: string | null;
}) {
	return r.img_kind
		? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
		: null;
}

const IMG_COLUMNS = `im.kind AS img_kind, im.path AS img_path, im.thumb_path AS img_thumb, im.source_url AS img_source`;

/**
 * Years the person has anything in, newest first (never a year still to come). Each year is a quick
 * look-up between the first and last day with a log or play, never a pass over all of them.
 */
export function reviewYears(userId: number, today: string = todayIso()): number[] {
	const sqlite = rawDb();
	const lists = visibleLists(userId, null);
	const now = Number(today.slice(0, 4));
	const found = new Set<number>();

	const logYears = logBounds(userId, null);
	if (logYears.first && logYears.last) {
		const hasLog = sqlite.prepare(
			`SELECT 1 FROM item_logs l INDEXED BY logs_user_date_source_idx
			 JOIN items i ON i.id = l.item_id
			 WHERE l.user_id = ? AND l.date BETWEEN ? AND ? AND ${IN_LISTS} LIMIT 1`
		);
		for (
			let y = Number(logYears.first.slice(0, 4));
			y <= Math.min(now, Number(logYears.last.slice(0, 4)));
			y++
		) {
			const { from, to } = bounds(y);
			if (isYear(y) && hasLog.get(userId, from, to, lists)) found.add(y);
		}
	}

	const edge = (order: 'ASC' | 'DESC') =>
		(
			sqlite
				.prepare(`SELECT date FROM lastfm_scrobbles WHERE user_id = ? ORDER BY date ${order} LIMIT 1`)
				.get(userId) as { date: string } | undefined
		)?.date;
	const firstPlay = edge('ASC');
	const lastPlay = edge('DESC');
	if (firstPlay && lastPlay) {
		const hasPlay = sqlite.prepare(
			'SELECT 1 FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ? LIMIT 1'
		);
		for (let y = Number(firstPlay.slice(0, 4)); y <= Math.min(now, Number(lastPlay.slice(0, 4))); y++) {
			const { from, to } = bounds(y);
			if (isYear(y) && hasPlay.get(userId, from, to)) found.add(y);
		}
	}

	// Episodes marked watched with a date of their own (their log's, or one imported with the history)
	for (const r of sqlite
		.prepare(
			`SELECT DISTINCT substr(COALESCE(l.date, w.watched_at), 1, 4) AS y FROM episode_watches w
			 LEFT JOIN item_logs l ON l.id = w.log_id
			 JOIN items i ON i.id = w.item_id
			 WHERE w.user_id = ? AND COALESCE(l.date, w.watched_at) IS NOT NULL AND ${IN_LISTS}`
		)
		.all(userId, lists) as { y: string }[]) {
		const y = Number(r.y);
		if (isYear(y) && y <= now) found.add(y);
	}
	return [...found].sort((a, b) => b - a);
}

interface HandLog {
	id: number;
	date: string;
	rating: number | null;
	location: string | null;
	itemId: number;
	title: string;
	itemRating: number | null;
	catId: number;
	catName: string;
	catIcon: string;
	catColor: string;
	catSlug: string;
	ownerId: number;
	ownerName: string;
	concert: number;
	movie: number;
	facts: string | null;
	img_kind: ImageRef['kind'] | null;
	img_path: string | null;
	img_thumb: string | null;
	img_source: string | null;
}

/** The best of a group of ratings (null when none has one) */
const best = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

/** Per item: how often it was logged and the best rating, newest log breaking ties for order */
interface ItemTally {
	itemId: number;
	title: string;
	coverUrl: string | null;
	count: number;
	logRating: number | null;
	itemRating: number | null;
	lastDate: string;
}

function tally(logs: HandLog[]) {
	const out = new Map<number, ItemTally>();
	for (const l of logs) {
		const t = out.get(l.itemId);
		if (!t) {
			out.set(l.itemId, {
				itemId: l.itemId,
				title: l.title,
				coverUrl: cover(l),
				count: 1,
				logRating: l.rating,
				itemRating: l.itemRating,
				lastDate: l.date
			});
		} else {
			t.count++;
			t.logRating = best(t.logRating, l.rating);
			if (l.date > t.lastDate) t.lastDate = l.date;
		}
	}
	return [...out.values()];
}

const toTile = (t: ItemTally): YearTile => ({
	itemId: t.itemId,
	title: t.title,
	coverUrl: t.coverUrl,
	rating: t.logRating ?? t.itemRating,
	count: t.count
});

/** Best rated first (a log's rating that year, else the item's own), then logged most, then newest */
function topRated(tallies: ItemTally[], limit: number): YearTile[] {
	return tallies
		.filter((t) => (t.logRating ?? t.itemRating) !== null)
		.sort(
			(a, b) =>
				(b.logRating ?? b.itemRating!) - (a.logRating ?? a.itemRating!) ||
				b.count - a.count ||
				(a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
				a.itemId - b.itemId
		)
		.slice(0, limit)
		.map(toTile);
}

function mostLogged(tallies: ItemTally[], limit: number): YearTile[] {
	return [...tallies]
		.sort(
			(a, b) =>
				b.count - a.count ||
				(a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
				a.itemId - b.itemId
		)
		.slice(0, limit)
		.map(toTile);
}

/** The longest run of consecutive days (the earliest wins a tie) */
function longestStreak(daysAsc: string[]) {
	let best: { from: string; to: string; days: number } | null = null;
	let from = '';
	let run = 0;
	let prev = '';
	for (const d of daysAsc) {
		if (prev && addDays(prev, 1) === d) run++;
		else {
			from = d;
			run = 1;
		}
		if (!best || run > best.days) best = { from, to: d, days: run };
		prev = d;
	}
	return best;
}

/** The day with the highest count (the earliest wins a tie) */
function busiestOf(counts: Map<string, number>) {
	let top: { date: string; count: number } | null = null;
	for (const [date, count] of counts) {
		if (!top || count > top.count || (count === top.count && date < top.date)) top = { date, count };
	}
	return top;
}

function monthOf(date: string) {
	return Number(date.slice(5, 7));
}

/** The year, as one person lived it. `today` decides whether it's still going. */
export function yearInReview(userId: number, year: number, today: string = todayIso()): YearReview {
	const sqlite = rawDb();
	const lists = visibleLists(userId, null);
	const { from, to } = bounds(year);

	// Hand-written logs of the year, on lists the person sees: the one pass most sections read from
	const logs = sqlite
		.prepare(
			`SELECT l.id, l.date, l.rating, l.location, l.item_id AS itemId, i.title, ${mine('rating')} AS itemRating,
				c.id AS catId, c.name AS catName, c.icon AS catIcon, c.color AS catColor, c.slug AS catSlug,
				c.user_id AS ownerId, o.username AS ownerName,
				(c.template_key = 'concerts' OR c.provider_kinds LIKE '%"lastfm:artist"%') AS concert,
				(i.provider = 'tmdb' AND i.provider_kind = 'movie') AS movie,
				CASE WHEN i.provider = 'tmdb' AND i.provider_kind = 'movie' THEN json_extract(i.metadata, '$.facts') END AS facts,
				${IMG_COLUMNS}
			 FROM ${ME} CROSS JOIN item_logs l INDEXED BY logs_user_source_date_idx
			 JOIN items i ON i.id = l.item_id
			 JOIN categories c ON c.id = i.category_id
			 JOIN users o ON o.id = c.user_id
			 ${PROGRESS_JOIN}
			 LEFT JOIN images im ON im.id = i.cover_image_id
			 WHERE l.user_id = me.id AND l.source IS NULL AND l.date BETWEEN ? AND ? AND ${IN_LISTS}
			 ORDER BY l.date, l.id`
		)
		.all(userId, from, to, lists) as HandLog[];

	// Imported listening: one entry per day, in whichever lists it landed
	const listeningRows = sqlite
		.prepare(
			`SELECT l.date, i.category_id AS catId FROM item_logs l INDEXED BY logs_user_source_date_idx
			 JOIN items i ON i.id = l.item_id
			 WHERE l.user_id = ? AND l.source = 'lastfm' AND l.date BETWEEN ? AND ? AND ${IN_LISTS}
			 GROUP BY l.date, i.category_id`
		)
		.all(userId, from, to, lists) as { date: string; catId: number }[];

	// --- Counts per day: the base of the numbers, the chart and the highlights
	const perDay = new Map<string, number>();
	for (const l of logs) perDay.set(l.date, (perDay.get(l.date) ?? 0) + 1);
	const listeningDays = new Set(listeningRows.map((r) => r.date));
	for (const d of listeningDays) perDay.set(d, (perDay.get(d) ?? 0) + 1);

	const months = Array<number>(12).fill(0);
	let logged = 0;
	for (const [d, n] of perDay) {
		months[monthOf(d) - 1] += n;
		logged += n;
	}
	const busiestMonthCount = Math.max(...months);
	const usedLists = new Set([...logs.map((l) => l.catId), ...listeningRows.map((r) => r.catId)]);

	// --- New: items, places and artists that weren't there before the year
	const yearItems = [...new Set(logs.map((l) => l.itemId))];
	const seenBefore = new Set(
		(
			sqlite
				.prepare(
					`SELECT DISTINCT item_id AS id FROM item_logs
					 WHERE user_id = ? AND date < ? AND item_id IN (SELECT value FROM json_each(?))`
				)
				.all(userId, from, JSON.stringify(yearItems)) as { id: number }[]
		).map((r) => r.id)
	);
	const newItemIds = new Set(yearItems.filter((id) => !seenBefore.has(id)));

	const newPlaces = (
		sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM (
					SELECT lower(trim(l.location)) AS place, MIN(l.date) AS firstDay
					FROM item_logs l INDEXED BY logs_user_source_date_idx
					JOIN items i ON i.id = l.item_id
					WHERE l.user_id = ? AND l.source IS NULL AND trim(COALESCE(l.location, '')) != '' AND ${IN_LISTS}
					GROUP BY place HAVING firstDay BETWEEN ? AND ?
				)`
			)
			.get(userId, lists, from, to) as { n: number }
	).n;

	// Concert artists logged for the first time, and last.fm artists played for the first time
	const newArtistNames = new Set<string>();
	for (const l of logs) {
		if (l.concert && newItemIds.has(l.itemId)) newArtistNames.add(foldName(l.title));
	}
	for (const a of sqlite
		.prepare(
			`SELECT artist, MIN(firstDay) AS firstDay FROM (
				SELECT a.artist, (SELECT MIN(s.date) FROM lastfm_scrobbles s WHERE s.album_id = a.id) AS firstDay
				FROM lastfm_albums a WHERE a.user_id = ?
			 ) WHERE firstDay IS NOT NULL GROUP BY lower(artist) HAVING MIN(firstDay) BETWEEN ? AND ?`
		)
		.all(userId, from, to) as { artist: string }[]) {
		newArtistNames.add(foldName(a.artist));
	}

	// --- Highlights from the logs
	const logRef = (l: HandLog): YearLogRef => ({
		itemId: l.itemId,
		title: l.title,
		date: l.date,
		listName: l.catName,
		listIcon: l.catIcon,
		coverUrl: cover(l)
	});
	let rated: HandLog | null = null;
	for (const l of logs) {
		if (l.rating !== null && (!rated || l.rating >= rated.rating!)) rated = l;
	}
	const busiestMonthIndex = months.indexOf(busiestMonthCount);

	// --- Every list with hand-written logs, the busiest first
	const byList = new Map<number, HandLog[]>();
	for (const l of logs) byList.set(l.catId, [...(byList.get(l.catId) ?? []), l]);
	const listSections: YearList[] = [...byList.values()]
		.map((ls) => {
			const t = tally(ls);
			const c = ls[0];
			return {
				id: c.catId,
				name: c.catName,
				icon: c.catIcon,
				color: c.catColor,
				slug: c.ownerId === userId ? c.catSlug : sharedSlug(c.catSlug, c.ownerName),
				logs: ls.length,
				items: t.length,
				topRated: topRated(t, 3),
				mostLogged: mostLogged(t, 5)
			};
		})
		.sort((a, b) => b.logs - a.logs || a.name.localeCompare(b.name) || a.id - b.id);

	return {
		year,
		headline: {
			logged,
			activeDays: perDay.size,
			lists: usedLists.size,
			newItems: logs.length ? newItemIds.size : 0,
			soFar: Number(today.slice(0, 4)) === year
		},
		months,
		highlights: {
			longestStreak: longestStreak([...perDay.keys()].sort()),
			busiestMonth: logged ? { month: busiestMonthIndex + 1, count: busiestMonthCount } : null,
			busiestDay: busiestOf(perDay),
			topRated: rated ? { ...logRef(rated), rating: rated.rating! } : null,
			newPlaces,
			newArtists: newArtistNames.size,
			first: logs.length ? logRef(logs[0]) : null,
			last: logs.length ? logRef(logs[logs.length - 1]) : null
		},
		lists: listSections,
		watching: watchingOf(userId, year, lists, logs),
		music: musicOf(userId, year, lists)
	};
}

// --- Watching ----------------------------------------------------------------------------------

/** A saved TMDB answer, whatever its age: lengths don't need to be fresh, and nothing is fetched here */
function savedTmdb<T>(key: string): T | null {
	const row = rawDb().prepare('SELECT value FROM provider_cache WHERE key = ?').get(key) as
		{ value: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.value) as T;
	} catch {
		return null;
	}
}

function watchingOf(userId: number, year: number, lists: string, logs: HandLog[]): YearWatching | null {
	const { from, to } = bounds(year);
	const movieLogs = logs.filter((l) => l.movie);
	const plays = rawDb()
		.prepare(
			`SELECT w.item_id AS itemId, w.season, w.episode, i.title, i.provider, i.provider_id AS providerId,
				COALESCE(l.date, w.watched_at) AS date
			 FROM episode_watches w
			 LEFT JOIN item_logs l ON l.id = w.log_id
			 JOIN items i ON i.id = w.item_id
			 WHERE w.user_id = ? AND COALESCE(l.date, w.watched_at) BETWEEN ? AND ? AND ${IN_LISTS}`
		)
		.all(userId, from, to, lists) as {
		itemId: number;
		season: number;
		episode: number;
		title: string;
		provider: string | null;
		providerId: string | null;
		date: string;
	}[];
	if (!movieLogs.length && !plays.length) return null;

	let minutes = 0;
	let approximate = false;
	const perDay = new Map<string, number>();
	const bump = (d: string) => perDay.set(d, (perDay.get(d) ?? 0) + 1);

	// A movie's length is on the item (TMDB's "Runtime" fact); without one, a usual length is assumed
	for (const l of movieLogs) {
		let facts: MetadataFact[] | null = null;
		try {
			facts = l.facts ? (JSON.parse(l.facts) as MetadataFact[]) : null;
		} catch {
			/* not a list of facts: no length known */
		}
		const known = runtimeFromFacts(Array.isArray(facts) ? facts : null);
		if (known === null) approximate = true;
		minutes += known ?? DEFAULT_MOVIE_MINUTES;
		bump(l.date);
	}

	// An episode's length comes from TMDB's saved season (then the show's latest episode), never a request
	const seasons = new Map<string, Map<number, number> | null>();
	const showMinutes = new Map<string, number | null>();
	const episodeMinutes = (tmdbId: string | null, season: number, episode: number) => {
		if (!tmdbId) return null;
		const key = `${tmdbId}:${season}`;
		if (!seasons.has(key)) {
			const s = savedTmdb<{ episodes?: { episode_number?: number; runtime?: number | null }[] }>(
				`tmdb:tv-season:${tmdbId}:${season}`
			);
			seasons.set(
				key,
				s?.episodes
					? new Map(
							s.episodes
								.filter((e) => typeof e.episode_number === 'number' && e.runtime)
								.map((e) => [e.episode_number!, e.runtime!])
						)
					: null
			);
		}
		const exact = seasons.get(key)?.get(episode);
		if (exact) return exact;
		if (!showMinutes.has(tmdbId)) {
			showMinutes.set(
				tmdbId,
				savedTmdb<{ last_episode_to_air?: { runtime?: number | null } | null }>(`tmdb:tv-air:${tmdbId}`)
					?.last_episode_to_air?.runtime || null
			);
		}
		return showMinutes.get(tmdbId) ?? null;
	};
	const shows = new Map<number, { title: string; episodes: number }>();
	for (const p of plays) {
		const known = episodeMinutes(p.provider === 'tmdb' ? p.providerId : null, p.season, p.episode);
		if (known === null) approximate = true;
		minutes += known ?? DEFAULT_EPISODE_MINUTES;
		bump(p.date);
		const s = shows.get(p.itemId) ?? { title: p.title, episodes: 0 };
		s.episodes++;
		shows.set(p.itemId, s);
	}

	let topShow: YearTile | null = null;
	for (const [itemId, s] of shows) {
		if (!topShow || s.episodes > topShow.count || (s.episodes === topShow.count && itemId < topShow.itemId)) {
			topShow = { itemId, title: s.title, coverUrl: null, rating: null, count: s.episodes };
		}
	}
	if (topShow) {
		const row = rawDb()
			.prepare(
				`SELECT ${mine('rating')} AS rating, ${IMG_COLUMNS}
				 FROM ${ME} CROSS JOIN items i ${PROGRESS_JOIN}
				 LEFT JOIN images im ON im.id = i.cover_image_id WHERE i.id = ?`
			)
			.get(userId, topShow.itemId) as (Parameters<typeof cover>[0] & { rating: number | null }) | undefined;
		if (row) topShow = { ...topShow, coverUrl: cover(row), rating: row.rating };
	}

	return {
		movies: movieLogs.length,
		episodes: plays.length,
		minutes,
		hours: Math.round(minutes / 60),
		approximate,
		topShow,
		topMovies: topRated(tally(movieLogs), 3),
		busiestDay: busiestOf(perDay)
	};
}

// --- Music -------------------------------------------------------------------------------------

function musicOf(userId: number, year: number, lists: string): YearMusic | null {
	const sqlite = rawDb();
	const { from, to } = bounds(year);

	// A year of plays is read through lastfm_scrobbles_user_date_idx: by day, then by album and by track
	const days = sqlite
		.prepare(
			`SELECT date, COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date`
		)
		.all(userId, from, to) as { date: string; n: number }[];
	if (!days.length) return null;

	let plays = 0;
	let biggest = days[0];
	const monthly = Array<number>(12).fill(0);
	for (const d of days) {
		plays += d.n;
		monthly[monthOf(d.date) - 1] += d.n;
		if (d.n > biggest.n) biggest = d;
	}
	const busiestMonthPlays = Math.max(...monthly);

	// Albums are counted before they are looked up, so the join is per album and not per play. The cover
	// and link are the matching item's, when it is still on a list the person sees.
	const albums = sqlite
		.prepare(
			`SELECT a.id, a.artist, a.title, i.id AS itemId, ${IMG_COLUMNS}, s.plays
			 FROM (
				SELECT album_id, COUNT(*) AS plays FROM lastfm_scrobbles
				WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY album_id
			 ) s
			 JOIN lastfm_albums a ON a.id = s.album_id
			 LEFT JOIN items i ON i.id = a.item_id AND ${IN_LISTS}
			 LEFT JOIN images im ON im.id = i.cover_image_id`
		)
		.all(userId, from, to, lists) as (Parameters<typeof cover>[0] & {
		id: number;
		artist: string;
		title: string;
		itemId: number | null;
		plays: number;
	})[];
	const byAlbum = new Map(albums.map((a) => [a.id, a]));
	const albumOrder = [...albums].sort(
		(a, b) => b.plays - a.plays || a.title.localeCompare(b.title) || a.id - b.id
	);

	// The same artist can be spelled two ways across albums: they are one artist
	const artists = new Map<
		string,
		{ artist: string; plays: number; albums: number; coverUrl: string | null }
	>();
	for (const a of albumOrder) {
		const key = foldName(a.artist) || a.artist.toLowerCase();
		const entry = artists.get(key) ?? { artist: a.artist, plays: 0, albums: 0, coverUrl: null };
		entry.plays += a.plays;
		entry.albums++;
		// The albums are in order of plays, so the first picture is the artist's most played album's
		entry.coverUrl ??= cover(a);
		artists.set(key, entry);
	}

	const tracks = (
		sqlite
			.prepare(
				'SELECT COUNT(DISTINCT track_key) AS n FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ?'
			)
			.get(userId, from, to) as { n: number }
	).n;
	// Plays stored before track names were kept have none: a track nobody has a name for isn't listed
	const topTracks = (
		sqlite
			.prepare(
				`SELECT track_key AS key, COUNT(*) AS plays, MAX(track) AS name, MIN(album_id) AS albumId
				 FROM lastfm_scrobbles WHERE user_id = ? AND date BETWEEN ? AND ?
				 GROUP BY track_key HAVING name IS NOT NULL ORDER BY plays DESC, key LIMIT 5`
			)
			.all(userId, from, to) as { key: string; plays: number; name: string; albumId: number }[]
	).map((t) => {
		const album = byAlbum.get(t.albumId);
		return {
			name: t.name,
			artist: album?.artist ?? '',
			plays: t.plays,
			coverUrl: album ? cover(album) : null
		};
	});

	return {
		plays,
		tracks,
		albums: albums.length,
		artists: artists.size,
		topAlbums: albumOrder.slice(0, 5).map((a) => ({
			itemId: a.itemId,
			title: a.title,
			artist: a.artist,
			plays: a.plays,
			coverUrl: cover(a)
		})),
		topArtists: [...artists.values()]
			.sort((a, b) => b.plays - a.plays || a.artist.localeCompare(b.artist))
			.slice(0, 5),
		topTracks,
		biggestDay: { date: biggest.date, plays: biggest.n },
		busiestMonth: { month: monthly.indexOf(busiestMonthPlays) + 1, plays: busiestMonthPlays }
	};
}
