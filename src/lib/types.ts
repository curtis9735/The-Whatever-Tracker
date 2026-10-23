// Types shared by server and client code.

export type StatusGroup = 'planned' | 'active' | 'done' | 'dropped';

export interface StatusDef {
	key: string;
	label: string;
	group: StatusGroup;
}

export type FieldType =
	'text' | 'longtext' | 'number' | 'date' | 'select' | 'multiselect' | 'boolean' | 'url';

export type FieldScope = 'item' | 'log';

/** What someone a list is shared with can do: edit items, or only keep their own progress */
export type ShareRole = 'edit' | 'view';

/** The viewer's access to a list: theirs, or shared with them */
export type ListAccess = 'owner' | ShareRole;

export interface FieldDef {
	key: string;
	label: string;
	type: FieldType;
	scope: FieldScope;
	options: string[];
	unit: string | null;
	showOnCard: boolean;
}

/** A provider "kind" key such as `tmdb:movie` or `bgg:boardgame`. */
export type KindKey = string;

export interface SearchResult {
	provider: string;
	kind: string;
	kindKey: KindKey;
	id: string;
	title: string;
	subtitle?: string;
	year?: string;
	imageUrl?: string;
	description?: string;
	url?: string;
}

export interface MetadataFact {
	label: string;
	value: string;
}

export interface NormalizedMetadata extends SearchResult {
	description?: string;
	genres?: string[];
	facts: MetadataFact[];
	/** Larger artwork than the search thumbnail, when the provider has it */
	largeImageUrl?: string;
	/** Who made it, for albums (kept in the item's metadata so albums can be matched by artist) */
	artist?: string;
	/** MusicBrainz ID, when the source gave one (last.fm artists), kept so setlist.fm can find them exactly */
	mbid?: string;
}

export interface LocalSearchHit {
	id: number;
	title: string;
	subtitle: string | null;
	categoryName: string;
	categoryIcon: string;
	categorySlug: string;
	status: string | null;
	rating: number | null;
	imageUrl: string | null;
}

export interface SetlistEvent {
	id: string;
	date: string; // YYYY-MM-DD
	artist: string;
	venue: string;
	city: string;
	country: string;
	tour?: string;
	url?: string;
	songs: { name: string; set?: string; info?: string; cover?: string }[];
}
