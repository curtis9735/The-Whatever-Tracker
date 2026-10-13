import type { FieldScope, FieldType, StatusDef } from '$lib/types';

export interface TemplateField {
	key: string;
	label: string;
	type: FieldType;
	scope?: FieldScope;
	options?: string[];
	unit?: string;
	showOnCard?: boolean;
}

export interface CategoryTemplate {
	key: string;
	name: string;
	icon: string;
	color: string;
	description: string;
	statuses: StatusDef[];
	providerKinds: string[];
	fields: TemplateField[];
}

const watchStatuses: StatusDef[] = [
	{ key: 'planning', label: 'Planning', group: 'planned' },
	{ key: 'watching', label: 'Watching', group: 'active' },
	{ key: 'completed', label: 'Completed', group: 'done' },
	{ key: 'paused', label: 'Paused', group: 'active' },
	{ key: 'dropped', label: 'Dropped', group: 'dropped' }
];

const tastingStatuses = (planned = 'Want to try'): StatusDef[] => [
	{ key: 'want', label: planned, group: 'planned' },
	{ key: 'own', label: 'In the fridge / cellar', group: 'active' },
	{ key: 'tried', label: 'Tried', group: 'done' },
	{ key: 'not-for-me', label: 'Not for me', group: 'dropped' }
];

export const TEMPLATES: CategoryTemplate[] = [
	{
		key: 'movies',
		name: 'Movies',
		icon: '🎬',
		color: 'indigo',
		description: 'Films, with posters and details from TMDB.',
		statuses: watchStatuses.filter((s) => s.key !== 'paused'),
		providerKinds: ['tmdb:movie'],
		fields: [{ key: 'where_watched', label: 'Where watched', type: 'text', scope: 'log' }]
	},
	{
		key: 'tv-shows',
		name: 'TV Shows',
		icon: '📺',
		color: 'sky',
		description: 'Series from TMDB, with season and episode progress.',
		statuses: watchStatuses,
		providerKinds: ['tmdb:tv'],
		fields: [
			{ key: 'current_season', label: 'Current season', type: 'number', showOnCard: true },
			{ key: 'current_episode', label: 'Current episode', type: 'number', showOnCard: true }
		]
	},
	{
		key: 'video-games',
		name: 'Video Games',
		icon: '🎮',
		color: 'violet',
		description: 'Games from IGDB.',
		statuses: [
			{ key: 'backlog', label: 'Backlog', group: 'planned' },
			{ key: 'playing', label: 'Playing', group: 'active' },
			{ key: 'beaten', label: 'Beaten', group: 'done' },
			{ key: 'paused', label: 'Paused', group: 'active' },
			{ key: 'dropped', label: 'Dropped', group: 'dropped' }
		],
		providerKinds: ['igdb:game'],
		fields: [
			{ key: 'platform', label: 'Platform', type: 'text', showOnCard: true },
			{ key: 'hours', label: 'Hours played', type: 'number', unit: 'h', scope: 'log' }
		]
	},
	{
		key: 'board-games',
		name: 'Board Games',
		icon: '🎲',
		color: 'amber',
		description: 'Your shelf and plays, with data from BoardGameGeek.',
		statuses: [
			{ key: 'wishlist', label: 'Wishlist', group: 'planned' },
			{ key: 'owned', label: 'Owned', group: 'active' },
			{ key: 'played', label: 'Played', group: 'done' },
			{ key: 'sold', label: 'Sold / traded', group: 'dropped' }
		],
		providerKinds: ['bgg:boardgame'],
		fields: [
			{ key: 'players', label: 'Players', type: 'number', scope: 'log' },
			{ key: 'winner', label: 'Winner', type: 'text', scope: 'log' }
		]
	},
	{
		key: 'concerts',
		name: 'Concerts',
		icon: '🎤',
		color: 'rose',
		description: 'Artists you have seen live. Each show is a log, with the setlist from setlist.fm.',
		statuses: [
			{ key: 'want', label: 'Want to see', group: 'planned' },
			{ key: 'seen', label: 'Seen', group: 'done' }
		],
		providerKinds: ['musicbrainz:artist', 'setlistfm:setlist'],
		fields: [
			{ key: 'with', label: 'Went with', type: 'text', scope: 'log' },
			{ key: 'opener', label: 'Opening act', type: 'text', scope: 'log' }
		]
	},
	{
		key: 'albums',
		name: 'Albums',
		icon: '💿',
		color: 'teal',
		description: 'Albums and EPs from MusicBrainz, with cover art.',
		statuses: [
			{ key: 'to-listen', label: 'To listen', group: 'planned' },
			{ key: 'listened', label: 'Listened', group: 'done' },
			{ key: 'owned', label: 'Owned', group: 'active' }
		],
		providerKinds: ['musicbrainz:album'],
		fields: [
			{ key: 'format', label: 'Format', type: 'select', options: ['Vinyl', 'CD', 'Digital', 'Cassette'] }
		]
	},
	{
		key: 'whiskey',
		name: 'Whiskey',
		icon: '🥃',
		color: 'orange',
		description: 'Bottles and tasting notes.',
		statuses: [
			{ key: 'wishlist', label: 'Wishlist', group: 'planned' },
			{ key: 'sealed', label: 'Sealed', group: 'active' },
			{ key: 'open', label: 'Open', group: 'active' },
			{ key: 'finished', label: 'Finished', group: 'done' },
			{ key: 'tasted', label: 'Tasted', group: 'done' }
		],
		providerKinds: [],
		fields: [
			{ key: 'distillery', label: 'Distillery', type: 'text', showOnCard: true },
			{
				key: 'type',
				label: 'Type',
				type: 'select',
				options: ['Single Malt', 'Blended Malt', 'Blend', 'Bourbon', 'Rye', 'Irish', 'Japanese', 'Other']
			},
			{ key: 'region', label: 'Region', type: 'text' },
			{ key: 'age', label: 'Age', type: 'number', unit: 'yrs', showOnCard: true },
			{ key: 'abv', label: 'ABV', type: 'number', unit: '%' },
			{ key: 'cask', label: 'Cask', type: 'text' },
			{ key: 'price', label: 'Price', type: 'number' },
			{ key: 'nose', label: 'Nose', type: 'longtext', scope: 'log' },
			{ key: 'palate', label: 'Palate', type: 'longtext', scope: 'log' },
			{ key: 'finish', label: 'Finish', type: 'longtext', scope: 'log' }
		]
	},
	{
		key: 'wine',
		name: 'Wine',
		icon: '🍷',
		color: 'red',
		description: 'Bottles, vintages and tastings.',
		statuses: tastingStatuses(),
		providerKinds: [],
		fields: [
			{ key: 'winery', label: 'Winery', type: 'text', showOnCard: true },
			{ key: 'varietal', label: 'Varietal', type: 'text' },
			{ key: 'vintage', label: 'Vintage', type: 'number', showOnCard: true },
			{ key: 'region', label: 'Region', type: 'text' },
			{ key: 'country', label: 'Country', type: 'text' },
			{
				key: 'color',
				label: 'Color',
				type: 'select',
				options: ['Red', 'White', 'Rosé', 'Orange', 'Sparkling', 'Dessert', 'Fortified']
			}
		]
	},
	{
		key: 'cheese',
		name: 'Cheese',
		icon: '🧀',
		color: 'amber',
		description: 'Every cheese worth remembering.',
		statuses: tastingStatuses(),
		providerKinds: [],
		fields: [
			{
				key: 'milk',
				label: 'Milk',
				type: 'multiselect',
				options: ['Cow', 'Goat', 'Sheep', 'Buffalo', 'Mixed'],
				showOnCard: true
			},
			{ key: 'country', label: 'Country', type: 'text', showOnCard: true },
			{
				key: 'texture',
				label: 'Texture',
				type: 'select',
				options: ['Fresh', 'Soft', 'Semi-soft', 'Semi-hard', 'Hard', 'Blue']
			},
			{ key: 'producer', label: 'Producer', type: 'text' },
			{ key: 'pairing', label: 'Paired with', type: 'text', scope: 'log' }
		]
	},
	{
		key: 'hot-sauces',
		name: 'Hot Sauces',
		icon: '🌶️',
		color: 'red',
		description: 'Heat, flavor and where to get more.',
		statuses: tastingStatuses(),
		providerKinds: [],
		fields: [
			{ key: 'brand', label: 'Brand', type: 'text', showOnCard: true },
			{ key: 'peppers', label: 'Peppers', type: 'text' },
			{ key: 'heat', label: 'Heat (1–10)', type: 'number', showOnCard: true },
			{ key: 'origin', label: 'Origin', type: 'text' },
			{ key: 'eaten_with', label: 'Eaten with', type: 'text', scope: 'log' }
		]
	},
	{
		key: 'cats',
		name: 'Cats',
		icon: '🐈',
		color: 'pink',
		description: 'Favorite cats you have met. Each encounter is a log with photos.',
		statuses: [
			{ key: 'friend', label: 'Friend', group: 'done' },
			{ key: 'acquaintance', label: 'Acquaintance', group: 'active' },
			{ key: 'hope-to-meet', label: 'Hope to meet', group: 'planned' }
		],
		providerKinds: [],
		fields: [
			{ key: 'breed', label: 'Breed', type: 'text', showOnCard: true },
			{ key: 'coat', label: 'Coat', type: 'text' },
			{ key: 'where_met', label: 'Where we met', type: 'text', showOnCard: true },
			{ key: 'human', label: 'Their human', type: 'text' },
			{ key: 'pets_allowed', label: 'Allows pets', type: 'boolean' }
		]
	}
];

export const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

/** Statuses used for categories created without a template. */
export const DEFAULT_STATUSES: StatusDef[] = [
	{ key: 'planned', label: 'Want', group: 'planned' },
	{ key: 'active', label: 'In progress', group: 'active' },
	{ key: 'done', label: 'Done', group: 'done' },
	{ key: 'dropped', label: 'Dropped', group: 'dropped' }
];
