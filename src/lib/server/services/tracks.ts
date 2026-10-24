import { rawDb } from '../db';
import { foldName } from '../providers/artist-images';
import { localDay } from './items';

/*
 * Which tracks of an album the viewer listened to, from their own last.fm plays. Only ever the viewer's
 * scrobbles, on the albums linked to the item: other people's plays are not read at all.
 * Tracks are matched to the album's tracklist (item metadata `tracks`) by their folded name.
 */

export interface TrackRow {
	name: string;
	/** 0 for a tracklist entry that was never played */
	plays: number;
	/** YYYY-MM-DD (server-local) of the latest play, null when never played */
	last: string | null;
}

export interface ListenedTracks {
	/** The album has a tracklist: `tracks` is it, in order, and `also` the played tracks that aren't on it */
	hasTracklist: boolean;
	tracks: TrackRow[];
	/** Without a tracklist: every played track, most plays first */
	also: TrackRow[];
}

export interface DayTrack {
	name: string;
	count: number;
}

/** The tracklist stored in an item's metadata, if it has a usable one */
export function tracklistOf(metadata: unknown): string[] {
	const list = (metadata as { tracks?: unknown } | null)?.tracks;
	if (!Array.isArray(list)) return [];
	return list
		.map((t) => (t as { name?: unknown } | null)?.name)
		.filter((n): n is string => typeof n === 'string' && !!n.trim());
}

/** "the sound of silence" → "The Sound Of Silence": the last resort when no readable name is known */
export function titleCase(folded: string) {
	return folded.replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase());
}

/** The part of a scrobble's track key after the artist: foldName never leaves a '|' in either part */
const trackPart = (key: string) => key.slice(key.indexOf('|') + 1);

interface Played {
	fold: string;
	name: string | null;
	plays: number;
	last: number;
}

/** Plays of the viewer's own on the item's albums, one entry per folded track name */
function playedTracks(userId: number, itemId: number, date?: string): Played[] {
	const rows = rawDb()
		.prepare(
			`SELECT s.track_key AS key, MAX(s.track) AS name, COUNT(*) AS plays, MAX(s.uts) AS last
			 FROM lastfm_scrobbles s JOIN lastfm_albums a ON a.id = s.album_id
			 WHERE s.user_id = @user AND a.user_id = @user AND a.item_id = @item
			 ${date ? 'AND s.date = @date' : ''}
			 GROUP BY s.track_key`
		)
		.all({ user: userId, item: itemId, ...(date ? { date } : {}) }) as {
		key: string;
		name: string | null;
		plays: number;
		last: number;
	}[];
	// The same track by two artists on one album (a compilation) is one row
	const merged = new Map<string, Played>();
	for (const r of rows) {
		const fold = trackPart(r.key);
		const p = merged.get(fold);
		if (!p) merged.set(fold, { fold, name: r.name, plays: r.plays, last: r.last });
		else {
			p.plays += r.plays;
			p.last = Math.max(p.last, r.last);
			p.name ??= r.name;
		}
	}
	return [...merged.values()];
}

/** First tracklist entry per folded name: where it sits and how it's spelled there */
function tracklistIndex(names: string[]) {
	const byFold = new Map<string, { pos: number; name: string }>();
	names.forEach((name, pos) => {
		const fold = foldName(name);
		if (!byFold.has(fold)) byFold.set(fold, { pos, name });
	});
	return byFold;
}

/** The viewer's tracks on an item: the tracklist with plays, then what else they played */
export function listenedTracks(userId: number, itemId: number, metadata: unknown): ListenedTracks {
	const names = tracklistOf(metadata);
	const played = playedTracks(userId, itemId);
	const day = (uts: number) => localDay(uts * 1000);
	const byPlays = (a: TrackRow, b: TrackRow) => b.plays - a.plays || a.name.localeCompare(b.name);

	if (!names.length) {
		return {
			hasTracklist: false,
			tracks: [],
			also: played
				.map((p) => ({ name: p.name ?? titleCase(p.fold), plays: p.plays, last: day(p.last) }))
				.sort(byPlays)
		};
	}
	const index = tracklistIndex(names);
	const playedByFold = new Map(played.map((p) => [p.fold, p]));
	// Plays belong to the first of two tracklist entries that fold to the same name
	const tracks: TrackRow[] = names.map((name, pos) => {
		const p = index.get(foldName(name))!.pos === pos ? playedByFold.get(foldName(name)) : undefined;
		return { name, plays: p?.plays ?? 0, last: p ? day(p.last) : null };
	});
	const also = played
		.filter((p) => !index.has(p.fold))
		.map((p) => ({ name: p.name ?? titleCase(p.fold), plays: p.plays, last: day(p.last) }))
		.sort(byPlays);
	return { hasTracklist: true, tracks, also };
}

/** The tracks the viewer played on one day (YYYY-MM-DD), in tracklist order when there is one, else most plays first */
export function tracksOnDay(userId: number, itemId: number, metadata: unknown, date: string): DayTrack[] {
	const index = tracklistIndex(tracklistOf(metadata));
	return playedTracks(userId, itemId, date)
		.map((p) => {
			const listed = index.get(p.fold);
			return {
				name: listed?.name ?? p.name ?? titleCase(p.fold),
				count: p.plays,
				pos: listed?.pos ?? Infinity
			};
		})
		.sort((a, b) => a.pos - b.pos || b.count - a.count || a.name.localeCompare(b.name))
		.map(({ name, count }) => ({ name, count }));
}
