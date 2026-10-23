import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { foldName } from './providers/artist-images';

// Matching last.fm albums against the items a list already holds, whatever their source
// (MusicBrainz, last.fm or typed by hand). Editions stay separate on purpose: "OK Computer (Deluxe
// Edition)" is a different album from "OK Computer", so titles are only folded, never trimmed.

/** "Daft Punk feat. Pharrell" and "Daft Punk" compare equal; so do "Simon & Garfunkel" and "Simon and Garfunkel" */
export function foldArtist(s: string): string {
	const cleaned = s
		.replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi, '')
		.replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
		.replace(/\s&\s/g, ' and ');
	return foldName(cleaned);
}

/** Case, accents, punctuation and spacing only. Edition suffixes are kept. */
export function foldAlbum(s: string): string {
	return foldName(s);
}

export function albumKey(artist: string, title: string): string {
	// Names that fold to nothing ("!!!") fall back to the lowercased text, so they don't all collide
	return `${foldArtist(artist) || artist.trim().toLowerCase()}\u0001${foldAlbum(title) || title.trim().toLowerCase()}`;
}

interface ItemLike {
	subtitle: string | null;
	metadata: Record<string, unknown> | null;
}

/** The artist an item is by: the stored artist, else the "Artist" fact, else the subtitle's first part */
export function artistOfItem(i: ItemLike): string | null {
	const stored = i.metadata?.artist;
	if (typeof stored === 'string' && stored.trim()) return stored.trim();
	const facts = i.metadata?.facts;
	if (Array.isArray(facts)) {
		for (const f of facts as { label?: unknown; value?: unknown }[]) {
			if (f?.label === 'Artist' && typeof f.value === 'string' && f.value.trim()) return f.value.trim();
		}
	}
	const first = i.subtitle?.split(' · ')[0]?.trim();
	return first || null;
}

export interface AlbumIndex {
	/** albumKey → item id */
	byKey: Map<string, number>;
	/** folded title → items that have no artist info at all */
	byTitleNoArtist: Map<string, number[]>;
	/** last.fm provider id → item id */
	byProviderId: Map<string, number>;
}

export interface IndexableItem extends ItemLike {
	id: number;
	title: string;
	provider?: string | null;
	providerKind?: string | null;
	providerId?: string | null;
}

export function emptyAlbumIndex(): AlbumIndex {
	return { byKey: new Map(), byTitleNoArtist: new Map(), byProviderId: new Map() };
}

export function indexAdd(ix: AlbumIndex, item: IndexableItem): void {
	if (item.provider === 'lastfm' && item.providerKind === 'album' && item.providerId) {
		if (!ix.byProviderId.has(item.providerId)) ix.byProviderId.set(item.providerId, item.id);
	}
	const artist = artistOfItem(item);
	if (artist) {
		const key = albumKey(artist, item.title);
		if (!ix.byKey.has(key)) ix.byKey.set(key, item.id);
	} else {
		const title = foldAlbum(item.title);
		const ids = ix.byTitleNoArtist.get(title) ?? [];
		ids.push(item.id);
		ix.byTitleNoArtist.set(title, ids);
	}
}

/** Every item of one list, indexed for matching */
export function buildAlbumIndex(categoryId: number): AlbumIndex {
	const ix = emptyAlbumIndex();
	const rows = db()
		.select({
			id: schema.items.id,
			title: schema.items.title,
			subtitle: schema.items.subtitle,
			metadata: schema.items.metadata,
			provider: schema.items.provider,
			providerKind: schema.items.providerKind,
			providerId: schema.items.providerId
		})
		.from(schema.items)
		.where(eq(schema.items.categoryId, categoryId))
		.all();
	for (const r of rows) indexAdd(ix, r);
	return ix;
}

/**
 * The item for an album, or null. Tries the last.fm id, then artist + title, then (for items with no
 * artist at all) the title alone, but only when it is long enough and just one such item has it.
 */
export function findAlbumItem(
	ix: AlbumIndex,
	artist: string,
	title: string,
	providerId?: string
): number | null {
	if (providerId) {
		const hit = ix.byProviderId.get(providerId);
		if (hit !== undefined) return hit;
	}
	const byKey = ix.byKey.get(albumKey(artist, title));
	if (byKey !== undefined) return byKey;
	const folded = foldAlbum(title);
	const bare = ix.byTitleNoArtist.get(folded);
	if (bare && bare.length === 1 && folded.length >= 4) return bare[0];
	return null;
}

// last.fm ids must fit the 400 characters a provider id may have. Base64 turns 3 bytes into 4
// characters, so the artist and title together are cut to 300 bytes (only very long names are affected).
const MAX_ID_BYTES = 300;
const SEP = '\u001f';

function shortenToBytes(parts: string[]): string[] {
	const out = parts.map((p) => [...p]);
	const size = () => Buffer.byteLength(out.map((p) => p.join('')).join(SEP));
	while (size() > MAX_ID_BYTES) {
		const longest = out.reduce((a, b) => (b.length > a.length ? b : a));
		longest.pop();
	}
	return out.map((p) => p.join(''));
}

function encodeParts(parts: string[]): string {
	return Buffer.from(shortenToBytes(parts).join(SEP), 'utf8').toString('base64url');
}

function decodeParts(id: string): string[] | null {
	if (!/^[\w-]{1,400}$/.test(id)) return null;
	const text = Buffer.from(id, 'base64url').toString('utf8');
	if (text.includes('�')) return null;
	return text.split(SEP);
}

export function lastfmAlbumId(artist: string, title: string): string {
	return encodeParts([artist, title]);
}

export function parseLastfmAlbumId(id: string): { artist: string; title: string } | null {
	const parts = decodeParts(id);
	if (!parts || parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { artist: parts[0], title: parts[1] };
}

export function lastfmArtistId(name: string): string {
	return encodeParts([name]);
}

export function parseLastfmArtistId(id: string): string | null {
	const parts = decodeParts(id);
	return parts && parts.length === 1 && parts[0] ? parts[0] : null;
}
