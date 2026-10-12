// Emoji offered by the list icon picker. Each entry: [emoji, "name: extra search words"].
// Kept to widely supported emoji (Unicode 13 or older, plus a few 14) so they render on
// current Windows, macOS, iOS and Android.

export interface IconOption {
	emoji: string;
	name: string;
	words: string[];
}

type Raw = [string, string];

const RAW_GROUPS: { label: string; icons: Raw[] }[] = [
	{
		label: 'Watch, play & listen',
		icons: [
			['🎬', 'movie: film cinema clapper'],
			['🍿', 'popcorn: movie snacks cinema'],
			['📺', 'tv: television show series'],
			['🎞️', 'film reel: movie cinema'],
			['🎮', 'video game: controller gaming console'],
			['🕹️', 'joystick: arcade retro game'],
			['🎲', 'dice: board game tabletop'],
			['♟️', 'chess: board game strategy'],
			['🧩', 'puzzle: jigsaw piece'],
			['🃏', 'cards: card game joker'],
			['🎤', 'microphone: concert singing karaoke gig live'],
			['🎙️', 'studio microphone: podcast radio'],
			['🎸', 'guitar: rock band music concert'],
			['🎹', 'piano: keyboard music'],
			['🥁', 'drum: music band'],
			['🎷', 'saxophone: jazz music'],
			['🎺', 'trumpet: brass music'],
			['🎻', 'violin: classical orchestra music'],
			['🎧', 'headphones: music podcast audio'],
			['🎵', 'music note: song track'],
			['💿', 'cd: album disc record music'],
			['📀', 'dvd: disc bluray'],
			['📻', 'radio: broadcast'],
			['🎭', 'theater: theatre drama play musical broadway'],
			['🎟️', 'ticket: event show admission'],
			['🎪', 'circus: festival tent'],
			['🎡', 'ferris wheel: fair amusement park'],
			['🎢', 'roller coaster: theme park ride'],
			['🎨', 'art: painting palette museum'],
			['🖼️', 'framed picture: art gallery'],
			['📚', 'books: reading library'],
			['📖', 'open book: reading novel'],
			['📰', 'newspaper: magazine news'],
			['📷', 'camera: photo photography'],
			['🎠', 'carousel: merry-go-round']
		]
	},
	{
		label: 'Food',
		icons: [
			['🧀', 'cheese: dairy'],
			['🌶️', 'hot pepper: chili spicy hot sauce'],
			['🍕', 'pizza: slice italian'],
			['🍔', 'burger: hamburger fast food'],
			['🌮', 'taco: mexican'],
			['🌯', 'burrito: wrap mexican'],
			['🍣', 'sushi: japanese fish'],
			['🍜', 'ramen: noodles soup'],
			['🍝', 'pasta: spaghetti italian'],
			['🍛', 'curry: rice indian'],
			['🥟', 'dumpling: gyoza dim sum'],
			['🍱', 'bento: lunch box japanese'],
			['🥩', 'steak: meat beef bbq'],
			['🍗', 'chicken leg: wings poultry'],
			['🌭', 'hot dog: sausage'],
			['🍟', 'fries: chips french fries'],
			['🥓', 'bacon: breakfast'],
			['🍳', 'cooking: frying pan egg breakfast recipe'],
			['🥗', 'salad: greens healthy'],
			['🦞', 'lobster: seafood'],
			['🦪', 'oyster: seafood shellfish'],
			['🍤', 'shrimp: prawn tempura seafood'],
			['🥐', 'croissant: bakery pastry'],
			['🍞', 'bread: loaf bakery'],
			['🥯', 'bagel: bakery'],
			['🥨', 'pretzel: snack'],
			['🍩', 'donut: doughnut'],
			['🍪', 'cookie: biscuit'],
			['🍰', 'cake: dessert slice'],
			['🧁', 'cupcake: muffin dessert'],
			['🍫', 'chocolate: candy bar cocoa'],
			['🍬', 'candy: sweets'],
			['🍦', 'ice cream: soft serve'],
			['🍨', 'gelato: ice cream dessert'],
			['🍎', 'apple: fruit'],
			['🍓', 'strawberry: berry fruit'],
			['🍑', 'peach: fruit'],
			['🥑', 'avocado: fruit'],
			['🍄', 'mushroom: fungi'],
			['🥜', 'peanuts: nuts snack'],
			['🍯', 'honey: jar sweet'],
			['🧂', 'salt: spice seasoning'],
			['🫒', 'olive: oil'],
			['🥫', 'canned food: tin can sauce soup'],
			['🍽️', 'restaurant: dining plate cutlery']
		]
	},
	{
		label: 'Drinks',
		icons: [
			['🍷', 'wine: red glass vineyard'],
			['🥂', 'champagne glasses: sparkling celebration toast'],
			['🍾', 'champagne bottle: sparkling bottle'],
			['🥃', 'whiskey: whisky bourbon scotch rum spirits tumbler'],
			['🍸', 'cocktail: martini gin'],
			['🍹', 'tropical drink: cocktail'],
			['🍺', 'beer: mug ale lager'],
			['🍻', 'beers: brewery pub cheers'],
			['🍶', 'sake: bottle'],
			['☕', 'coffee: espresso cafe latte'],
			['🫖', 'teapot: tea'],
			['🍵', 'tea: matcha green cup'],
			['🧋', 'bubble tea: boba milk tea'],
			['🥤', 'soda: cup straw drink pop'],
			['🧃', 'juice box: juice'],
			['🥛', 'milk: glass dairy'],
			['🧉', 'mate: yerba'],
			['💧', 'water: drop droplet'],
			['🚰', 'drinking water: tap fountain water bottle refill'],
			['🫗', 'pouring: liquid water bottle'],
			['🧴', 'bottle: lotion water bottle flask'],
			['🍼', 'baby bottle: bottle milk'],
			['🧊', 'ice: cube cold']
		]
	},
	{
		label: 'Animals',
		icons: [
			['🐈', 'cat: kitty feline pet'],
			['🐱', 'cat face: kitten kitty'],
			['🐕', 'dog: pet canine'],
			['🐶', 'dog face: puppy'],
			['🐾', 'paw prints: pets'],
			['🐇', 'rabbit: bunny'],
			['🐹', 'hamster: pet rodent'],
			['🦔', 'hedgehog'],
			['🐎', 'horse: riding equestrian'],
			['🐄', 'cow: farm'],
			['🐑', 'sheep: lamb farm'],
			['🐐', 'goat: farm'],
			['🐔', 'chicken: hen farm'],
			['🐦', 'bird: birdwatching'],
			['🦜', 'parrot: bird'],
			['🦉', 'owl: bird'],
			['🦆', 'duck: bird'],
			['🐟', 'fish: fishing'],
			['🐠', 'tropical fish: aquarium'],
			['🐢', 'turtle: tortoise reptile'],
			['🦎', 'lizard: reptile gecko'],
			['🐍', 'snake: reptile'],
			['🦋', 'butterfly: insect'],
			['🐝', 'bee: honey insect'],
			['🐞', 'ladybug: insect beetle'],
			['🐻', 'bear'],
			['🦊', 'fox'],
			['🐼', 'panda'],
			['🐘', 'elephant: zoo'],
			['🦁', 'lion: zoo safari'],
			['🦄', 'unicorn: fantasy'],
			['🐉', 'dragon: fantasy']
		]
	},
	{
		label: 'Nature & places',
		icons: [
			['🌸', 'blossom: flower cherry'],
			['🌹', 'rose: flower'],
			['🌻', 'sunflower: flower'],
			['🌷', 'tulip: flower'],
			['🪴', 'potted plant: houseplant plants'],
			['🌵', 'cactus: succulent desert'],
			['🌿', 'herb: leaves plant'],
			['🍀', 'clover: luck'],
			['🌳', 'tree: park'],
			['🌲', 'evergreen: forest pine'],
			['🍁', 'maple leaf: autumn fall'],
			['🌊', 'wave: ocean sea surf'],
			['⛰️', 'mountain: hike'],
			['🏔️', 'snowy mountain: peak summit'],
			['🌋', 'volcano'],
			['🏝️', 'island: beach tropical'],
			['🏖️', 'beach: umbrella vacation'],
			['🏕️', 'camping: tent campsite'],
			['🌅', 'sunrise: sunset'],
			['🌙', 'moon: night'],
			['⭐', 'star: favorite'],
			['🌈', 'rainbow'],
			['☀️', 'sun: sunny'],
			['❄️', 'snowflake: snow winter'],
			['🌍', 'globe: world earth countries'],
			['🗺️', 'map: world travel'],
			['📍', 'pin: place location'],
			['🏛️', 'museum: classical building'],
			['🏰', 'castle: palace'],
			['🗽', 'statue: landmark monument'],
			['🏟️', 'stadium: arena sports venue'],
			['🏨', 'hotel: stay'],
			['🏠', 'house: home'],
			['⛪', 'church: chapel']
		]
	},
	{
		label: 'Travel & sport',
		icons: [
			['✈️', 'airplane: plane flight travel trip'],
			['🧳', 'luggage: suitcase travel'],
			['🚗', 'car: auto drive road trip'],
			['🚲', 'bicycle: bike'],
			['🏍️', 'motorcycle: motorbike'],
			['🚂', 'train: locomotive railway'],
			['🚢', 'ship: cruise boat'],
			['⛵', 'sailboat: sailing'],
			['🚀', 'rocket: space'],
			['🧭', 'compass: navigation'],
			['🎒', 'backpack: hiking school'],
			['🥾', 'hiking boot: hike trail'],
			['⚽', 'soccer: football'],
			['🏀', 'basketball'],
			['🏈', 'american football: nfl'],
			['⚾', 'baseball'],
			['🎾', 'tennis'],
			['🏐', 'volleyball'],
			['🏒', 'hockey: ice hockey'],
			['⛳', 'golf'],
			['🎳', 'bowling'],
			['🏓', 'ping pong: table tennis'],
			['🥊', 'boxing: glove'],
			['🏃', 'running: run race marathon'],
			['🧗', 'climbing: bouldering'],
			['🏊', 'swimming: swim pool'],
			['🚴', 'cycling: bike ride'],
			['⛷️', 'skiing: ski'],
			['🏂', 'snowboarding: snowboard'],
			['🏄', 'surfing: surf'],
			['🎣', 'fishing: fish rod'],
			['🧘', 'yoga: meditation'],
			['🏋️', 'weightlifting: gym workout'],
			['🎯', 'target: darts goal bullseye'],
			['🏆', 'trophy: award win'],
			['🥇', 'medal: gold first']
		]
	},
	{
		label: 'Things & hobbies',
		icons: [
			['📦', 'box: package parcel'],
			['🗃️', 'card file box: collection'],
			['🏷️', 'tag: label'],
			['👟', 'sneakers: shoes trainers'],
			['👠', 'heels: shoes'],
			['👗', 'dress: fashion clothes'],
			['👕', 't-shirt: shirt clothing'],
			['🧢', 'cap: hat baseball'],
			['🎩', 'top hat: hat'],
			['👜', 'handbag: bag purse'],
			['👓', 'glasses: eyeglasses'],
			['🕶️', 'sunglasses: shades'],
			['⌚', 'watch: wristwatch time'],
			['💍', 'ring: jewelry'],
			['💎', 'gem: diamond jewel'],
			['💄', 'lipstick: makeup cosmetics'],
			['🧼', 'soap: bath'],
			['🕯️', 'candle: scent'],
			['🌂', 'umbrella'],
			['🪙', 'coin: money currency'],
			['💰', 'money bag: cash'],
			['📮', 'postbox: mail stamps'],
			['✉️', 'envelope: letter mail'],
			['🖋️', 'fountain pen: writing ink'],
			['✏️', 'pencil: drawing'],
			['📓', 'notebook: journal'],
			['🖌️', 'paintbrush: painting'],
			['🧶', 'yarn: knitting crochet'],
			['🧵', 'thread: sewing'],
			['✂️', 'scissors: crafts'],
			['🧸', 'teddy bear: toy plush'],
			['🪀', 'yo-yo: toy'],
			['🪁', 'kite'],
			['🎁', 'gift: present'],
			['🎈', 'balloon: party'],
			['🎉', 'party: celebration confetti'],
			['🪄', 'magic wand: magic'],
			['🔭', 'telescope: astronomy stars'],
			['🔬', 'microscope: science'],
			['🧪', 'test tube: chemistry science'],
			['💊', 'pill: medicine vitamins'],
			['🔧', 'wrench: tools'],
			['🧰', 'toolbox: tools'],
			['🔦', 'flashlight: torch'],
			['🔪', 'knife: kitchen cutlery'],
			['🪑', 'chair: furniture'],
			['🛋️', 'couch: sofa furniture'],
			['💻', 'laptop: computer'],
			['🖥️', 'desktop computer: pc'],
			['📱', 'phone: mobile apps'],
			['⌨️', 'keyboard: typing'],
			['🗝️', 'old key: antique'],
			['🏺', 'amphora: pottery vase'],
			['⚱️', 'urn: vase pottery']
		]
	},
	{
		label: 'Symbols',
		icons: [
			['❤️', 'heart: love favorite'],
			['✨', 'sparkles: shiny new'],
			['🔥', 'fire: hot lit'],
			['💯', 'hundred: perfect score'],
			['✅', 'check mark: done complete'],
			['📌', 'pushpin: pin'],
			['🔖', 'bookmark'],
			['📋', 'clipboard: list'],
			['📝', 'memo: note notes'],
			['💡', 'idea: light bulb'],
			['🗂️', 'dividers: folders files'],
			['👻', 'ghost: horror halloween'],
			['💀', 'skull: horror'],
			['👽', 'alien: sci-fi space'],
			['🤖', 'robot: tech'],
			['🧙', 'wizard: mage fantasy'],
			['🦸', 'superhero: hero comics'],
			['⚡', 'lightning: electric energy'],
			['🌀', 'cyclone: spiral'],
			['🎀', 'ribbon: bow']
		]
	}
];

function parse([emoji, text]: Raw): IconOption {
	const [name, extra = ''] = text.split(':');
	const words = `${name} ${extra}`
		.toLowerCase()
		.split(/[\s-]+/)
		.filter(Boolean);
	return { emoji, name: name.trim(), words };
}

export const ICON_GROUPS = RAW_GROUPS.map((g) => ({ label: g.label, icons: g.icons.map(parse) }));

const ALL: IconOption[] = (() => {
	const seen = new Set<string>();
	return ICON_GROUPS.flatMap((g) => g.icons).filter((i) =>
		seen.has(i.emoji) ? false : (seen.add(i.emoji), true)
	);
})();

/** Every typed word must start one of the icon's words ("whis" → 🥃). */
export function searchIcons(query: string): IconOption[] {
	const terms = query
		.toLowerCase()
		.split(/[\s-]+/)
		.filter(Boolean);
	if (!terms.length) return [];
	return ALL.filter((i) => terms.every((t) => i.words.some((w) => w.startsWith(t))));
}

function singular(word: string) {
	if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
	if (word.endsWith('es') && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
	if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
	return word;
}

/** Icons whose words match the words of a list name ("Water Bottles" → 💧 🚰 🫗 🧴 …). */
export function suggestIcons(listName: string, limit = 10): IconOption[] {
	const words = listName
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((w) => w.length >= 3)
		.map(singular);
	if (!words.length) return [];
	const scored = ALL.map((icon) => {
		let score = 0;
		for (const w of words) {
			if (icon.words.includes(w)) score += 2;
			else if (icon.words.some((iw) => iw.length >= 4 && (iw.startsWith(w) || w.startsWith(iw)))) score += 1;
		}
		return { icon, score };
	}).filter((s) => s.score > 0);
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.icon);
}

/** First visible character (grapheme) of the input, so emoji with joiners or flags stay whole. */
export function firstGrapheme(raw: string): string {
	const s = raw.trim();
	if (!s) return '';
	const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	for (const { segment } of seg.segment(s)) return segment;
	return '';
}

/** Sanitizes a submitted list icon: one grapheme, or the default box. */
export function cleanIcon(raw: unknown): string {
	const g = firstGrapheme(String(raw ?? ''));
	return g && g.length <= 32 ? g : '📦';
}
