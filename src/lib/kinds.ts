// Provider kinds: what each metadata source can find. Client-safe (no secrets).

export interface KindInfo {
	key: string;
	provider: string;
	/** What a list holding these is about, as shown in List settings */
	label: string;
	icon: string;
	/** What looking it up fills in */
	gives: string;
	/** Search result group title */
	group: string;
	order: number;
	/** Not offered when picking sources, but lists that already have it keep working */
	hidden?: boolean;
}

export const KINDS: KindInfo[] = [
	{
		key: 'tmdb:movie',
		provider: 'tmdb',
		label: 'Movies',
		icon: '🎬',
		gives: 'Poster, release date, runtime, director and cast',
		group: 'Movies',
		order: 1
	},
	{
		key: 'tmdb:tv',
		provider: 'tmdb',
		label: 'TV shows',
		icon: '📺',
		gives: 'Poster, seasons, network and cast',
		group: 'TV Shows',
		order: 2
	},
	{
		key: 'igdb:game',
		provider: 'igdb',
		label: 'Video games',
		icon: '🎮',
		gives: 'Cover, platforms, developer and release date',
		group: 'Video Games',
		order: 3
	},
	{
		key: 'bgg:boardgame',
		provider: 'bgg',
		label: 'Board games',
		icon: '🎲',
		gives: 'Box art, player count, play time and designer',
		group: 'Board Games',
		order: 4
	},
	{
		key: 'musicbrainz:artist',
		provider: 'musicbrainz',
		label: 'Music artists',
		icon: '🎤',
		gives: 'Photo, where they’re from, genres and website',
		group: 'Artists',
		order: 5,
		hidden: true
	},
	{
		key: 'musicbrainz:album',
		provider: 'musicbrainz',
		label: 'Albums',
		icon: '💿',
		gives: 'Cover art, artist and release date',
		group: 'Albums',
		order: 6,
		hidden: true
	},
	{
		key: 'lastfm:album',
		provider: 'lastfm',
		label: 'Music',
		icon: '💿',
		gives: 'Albums you listen to: cover art, genres, a short description, listeners and plays',
		group: 'Albums',
		order: 7
	},
	{
		key: 'lastfm:artist',
		provider: 'lastfm',
		label: 'Concerts',
		icon: '🎤',
		gives: 'Artists you see live: photo, genres, a short bio, listeners and plays',
		group: 'Artists',
		order: 8
	}
];

/** Kinds whose lists hold albums (listening history from last.fm is matched against these) */
export const ALBUM_KINDS = ['lastfm:album', 'musicbrainz:album'];

/**
 * What to save as a list's sources: the ticked ones, plus any hidden kind the list already had
 * (hidden kinds have no card, so they are never in the submitted form).
 */
export function keepHiddenKinds(submitted: string[], existing: string[]) {
	const hidden = new Set(KINDS.filter((k) => k.hidden).map((k) => k.key));
	const kept = existing.filter((k) => hidden.has(k) && !submitted.includes(k));
	return [...submitted, ...kept];
}

export const KIND_BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/**
 * Sources used while *logging* rather than in search. Stored alongside the search kinds in a
 * list's providerKinds, so a list opts in the same way.
 */
export const LOG_SOURCES = [
	{
		key: 'setlistfm:setlist',
		provider: 'setlistfm',
		label: 'Concert setlists',
		gives: 'Each show you log gets its venue, tour and songs, found by artist and date',
		/** Offered for lists of these (or already turned on) */
		forKinds: ['musicbrainz:artist', 'lastfm:artist']
	}
] as const;

export const SETLIST_SOURCE = 'setlistfm:setlist';

export const PROVIDER_LABELS: Record<string, string> = {
	tmdb: 'TMDB',
	igdb: 'IGDB',
	bgg: 'BoardGameGeek',
	musicbrainz: 'MusicBrainz',
	lastfm: 'last.fm',
	setlistfm: 'setlist.fm',
	openfoodfacts: 'Open Food Facts'
};

/** Accent colors a category can use (applied via a CSS variable, so no dynamic Tailwind classes). */
export const CATEGORY_COLORS: Record<string, string> = {
	slate: '#64748b',
	red: '#ef4444',
	orange: '#f97316',
	amber: '#f59e0b',
	lime: '#84cc16',
	emerald: '#10b981',
	teal: '#14b8a6',
	sky: '#0ea5e9',
	indigo: '#6366f1',
	violet: '#8b5cf6',
	pink: '#ec4899',
	rose: '#f43f5e'
};

export function categoryColor(name: string) {
	return CATEGORY_COLORS[name] ?? CATEGORY_COLORS.slate;
}
