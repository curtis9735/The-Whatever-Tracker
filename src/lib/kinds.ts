// Provider kinds: what each metadata source can find. Client-safe (no secrets).

export interface KindInfo {
	key: string;
	provider: string;
	label: string;
	/** Search result group title */
	group: string;
	order: number;
}

export const KINDS: KindInfo[] = [
	{ key: 'tmdb:movie', provider: 'tmdb', label: 'Movie (TMDB)', group: 'Movies', order: 1 },
	{ key: 'tmdb:tv', provider: 'tmdb', label: 'TV show (TMDB)', group: 'TV Shows', order: 2 },
	{ key: 'igdb:game', provider: 'igdb', label: 'Video game (IGDB)', group: 'Video Games', order: 3 },
	{
		key: 'bgg:boardgame',
		provider: 'bgg',
		label: 'Board game (BoardGameGeek)',
		group: 'Board Games',
		order: 4
	},
	{
		key: 'musicbrainz:artist',
		provider: 'musicbrainz',
		label: 'Artist (MusicBrainz)',
		group: 'Artists',
		order: 5
	},
	{
		key: 'musicbrainz:album',
		provider: 'musicbrainz',
		label: 'Album (MusicBrainz)',
		group: 'Albums',
		order: 6
	}
];

export const KIND_BY_KEY = new Map(KINDS.map((k) => [k.key, k]));

/**
 * Sources used while *logging* rather than in search. Stored alongside the search kinds in a
 * list's providerKinds, so a list opts in the same way.
 */
export const LOG_SOURCES = [
	{
		key: 'setlistfm:setlist',
		provider: 'setlistfm',
		label: 'Concert setlists (setlist.fm)',
		hint: 'Find the show (venue, date, songs) when you log one'
	}
] as const;

export const SETLIST_SOURCE = 'setlistfm:setlist';

export const PROVIDER_LABELS: Record<string, string> = {
	tmdb: 'TMDB',
	igdb: 'IGDB',
	bgg: 'BoardGameGeek',
	musicbrainz: 'MusicBrainz',
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
