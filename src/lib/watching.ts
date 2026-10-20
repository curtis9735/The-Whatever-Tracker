// Watching now: a live check-in for a movie or an episode. It runs for the movie's or episode's
// length (from TMDB), and when the time is up the movie or episode is marked watched on its own.

import { episodeCode } from './episodes';
import type { MetadataFact } from './types';

export type WatchKind = 'movie' | 'episode';

/** An item's cover, in the shape imageSrc() takes */
export interface WatchImage {
	kind: 'upload' | 'url_copy' | 'url_link';
	path: string | null;
	thumbPath: string | null;
	sourceUrl: string | null;
}

interface WatchTarget {
	itemId: number;
	/** The movie's or show's title */
	title: string;
	kind: WatchKind;
	/** Episodes: which one (null for movies) */
	season: number | null;
	episode: number | null;
	episodeTitle: string | null;
	/** The list, as the viewer reaches it (`slug@owner` for a list shared with them) */
	categorySlug: string;
	categoryIcon: string;
	image: WatchImage | null;
}

/** The viewer's check-in that is running (or paused) right now */
export interface LiveCheckin extends WatchTarget {
	id: number;
	/** When they checked in (ms) */
	checkedInAt: number;
	/** How long it runs (ms) */
	durationMs: number;
	/** When it finishes on its own (ms). While paused this is where it stood; resuming moves it later. */
	endsAt: number;
	/** Set while paused (ms) */
	pausedAt: number | null;
	/** Whether the length came from TMDB (false: a usual length was assumed) */
	runtimeKnown: boolean;
}

/** A check-in that just ended by being watched: shown with "Rate it" and Undo until dismissed */
export interface FinishedCheckin extends WatchTarget {
	id: number;
	endedAt: number;
	/** 'auto': the time ran out; 'early': marked watched before then */
	how: 'auto' | 'early';
	/** The log it added (for "Rate it"), when there is one */
	logId: number | null;
	/** The status it ended on, e.g. "Completed", or null when the status was left alone */
	statusLabel: string | null;
}

/** What every page gets (the app layout's `watching`) */
export interface WatchingState {
	live: LiveCheckin | null;
	finished: FinishedCheckin | null;
	/** The server's clock when this was loaded, so countdowns don't depend on the device's clock */
	now: number;
}

/** Usual lengths, when TMDB doesn't say */
export const DEFAULT_MOVIE_MINUTES = 120;
export const DEFAULT_EPISODE_MINUTES = 45;

/** A finished check-in is offered (Rate it / Undo) for this long, unless dismissed */
export const FINISHED_SHOWN_MS = 3 * 3_600_000;

type Timing = Pick<LiveCheckin, 'durationMs' | 'endsAt' | 'pausedAt'>;

/** Time left (ms, never below 0) at `now`; a paused check-in keeps what it had left when paused */
export function timeLeft(c: Timing, now: number) {
	return Math.max(0, c.endsAt - (c.pausedAt ?? now));
}

/** How far along it is, 0–1 */
export function watchProgress(c: Timing, now: number) {
	if (c.durationMs <= 0) return 1;
	return Math.min(1, Math.max(0, 1 - timeLeft(c, now) / c.durationMs));
}

/** "2h 13m", "45 min", "Less than a minute" */
export function formatLength(ms: number) {
	const min = Math.ceil(ms / 60_000);
	if (ms <= 0) return '0 min';
	if (min <= 1 && ms < 60_000) return 'Less than a minute';
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m} min`;
}

/** "S2 E5 · Title" for an episode, null for a movie */
export function watchLabel(c: Pick<WatchTarget, 'kind' | 'season' | 'episode' | 'episodeTitle'>) {
	if (c.kind !== 'episode' || c.season === null || c.episode === null) return null;
	return `${episodeCode(c.season, c.episode)}${c.episodeTitle ? ` · ${c.episodeTitle}` : ''}`;
}

/** Minutes from TMDB's "Runtime" fact on a movie ("2h 13m", "45m"), or null */
export function runtimeFromFacts(facts: MetadataFact[] | null | undefined): number | null {
	const v = facts?.find((f) => f.label === 'Runtime')?.value;
	const m = v?.match(/^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$/);
	if (!m || (!m[1] && !m[2])) return null;
	const min = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
	return min > 0 ? min : null;
}

/** Items that can be checked in to: movies and shows linked to TMDB */
export function watchKindOf(item: {
	provider: string | null;
	providerKind: string | null;
	providerId: string | null;
}): WatchKind | null {
	if (item.provider !== 'tmdb' || !/^\d+$/.test(item.providerId ?? '')) return null;
	if (item.providerKind === 'movie') return 'movie';
	if (item.providerKind === 'tv') return 'episode';
	return null;
}
