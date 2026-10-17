import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { getProvider } from '../providers/registry';
import { ProviderError } from '../providers/util';
import { getCategoryById } from './categories';
import { addImage, createItem, getItem, updateItem } from './items';
import { listAccess } from './access';
import { addLogWithShow, afterAddPath } from './concerts';
import { refreshItemReleases } from './releases';
import { libraryMatches, reindexItem } from '../search/local';
import type { NormalizedMetadata } from '$lib/types';

export function metadataToStore(d: NormalizedMetadata) {
	return {
		year: d.year ?? null,
		genres: d.genres ?? [],
		facts: d.facts,
		url: d.url ?? null,
		imageUrl: d.largeImageUrl ?? d.imageUrl ?? null,
		fetchedAt: new Date().toISOString()
	};
}

export async function fetchDetails(providerId: string, kind: string, id: string, signal?: AbortSignal) {
	const provider = getProvider(providerId);
	if (!provider || !provider.kinds.includes(`${providerId}:${kind}`)) error(404, 'Unknown source');
	if (!provider.enabled()) error(503, `${provider.label} is not configured`);
	try {
		return await provider.details(kind, id, signal);
	} catch (e) {
		if (e instanceof ProviderError) error(e.status === 404 ? 404 : 502, e.message);
		throw e;
	}
}

/** `ownerId`'s item for a source entry, on any of their lists (one at most: it's unique per owner) */
function ownersItem(ownerId: number, provider: string, kind: string, id: string) {
	return (
		db()
			.select({ id: schema.items.id })
			.from(schema.items)
			.where(
				and(
					eq(schema.items.userId, ownerId),
					eq(schema.items.provider, provider),
					eq(schema.items.providerKind, kind),
					eq(schema.items.providerId, id)
				)
			)
			.get()?.id ?? null
	);
}

/**
 * The item for a source entry that the viewer already has: on their own lists first, then on lists
 * shared with them. `ownOnly` looks at their own lists only.
 */
export function findExisting(
	userId: number,
	provider: string,
	kind: string,
	id: string,
	{ ownOnly = false }: { ownOnly?: boolean } = {}
) {
	if (ownOnly) return ownersItem(userId, provider, kind, id);
	return libraryMatches(userId, [{ provider, kind, id }])[`${provider}:${kind}:${id}`] ?? null;
}

/**
 * Someone else's list can only have one item per source entry across all of its owner's lists. When
 * the owner already has it on a list the viewer can't see, adding or linking it there is refused.
 */
function hiddenClash(ownerName: string | null) {
	return `${ownerName ?? "The list's owner"} already has this in a list that isn't shared with you.`;
}

export interface AddFromProviderInput {
	provider: string;
	kind: string;
	id: string;
	categoryId: number;
	status: string | null;
	rating: number | null;
	logDate: string | null;
	logNotes?: string | null;
}

/** Creates a library item from a search result, with artwork linked from the provider. */
export async function addFromProvider(userId: number, input: AddFromProviderInput) {
	const existing = findExisting(userId, input.provider, input.kind, input.id);
	if (existing) return { id: existing, created: false };

	// 404 if the list isn't the viewer's, 403 if it's shared with them only to view
	const { category } = getCategoryById(userId, input.categoryId, 'edit');
	if (category.userId !== userId && ownersItem(category.userId, input.provider, input.kind, input.id)) {
		error(409, hiddenClash(category.ownerName));
	}
	const d = await fetchDetails(input.provider, input.kind, input.id);
	const status =
		input.status && category.statuses.some((s) => s.key === input.status)
			? input.status
			: (category.statuses[0]?.key ?? null);

	const item = createItem(userId, {
		categoryId: category.id,
		title: d.title,
		subtitle: d.subtitle ?? null,
		description: d.description ?? null,
		status,
		rating: input.rating,
		provider: input.provider,
		providerKind: input.kind,
		providerId: input.id,
		externalUrl: d.url ?? null,
		metadata: metadataToStore(d)
	});

	const art = d.largeImageUrl ?? d.imageUrl;
	if (art) await addImage(userId, { itemId: item.id }, { type: 'url', url: art, linkOnly: true });
	let first: Awaited<ReturnType<typeof addLogWithShow>> | null = null;
	if (input.logDate) {
		// Concerts: the setlist.fm show from that day comes along with the first log
		first = await addLogWithShow(userId, item.id, category, {
			date: input.logDate,
			rating: input.rating,
			notes: input.logNotes ?? null
		});
	}
	reindexItem(item.id);
	lookUpReleases(userId, item.id);
	return {
		id: item.id,
		created: true,
		show: first?.show ?? null,
		next: afterAddPath(item.id, first?.log.id ?? null, first?.show ?? null)
	};
}

export interface ProviderRef {
	provider: string;
	kind: string;
	id: string;
}

/** Reads a match chosen in a form (hidden match_provider / match_kind / match_id inputs). */
export function parseMatch(form: FormData): ProviderRef | null {
	const provider = String(form.get('match_provider') ?? '');
	const kind = String(form.get('match_kind') ?? '');
	const id = String(form.get('match_id') ?? '');
	if (!provider || !kind || !id) return null;
	const p = getProvider(provider);
	if (!p || !p.kinds.includes(`${provider}:${kind}`) || !/^[\w-]{1,100}$/.test(id)) return null;
	return { provider, kind, id };
}

export class MatchError extends Error {
	constructor(
		message: string,
		public existingId: number | null = null
	) {
		super(message);
	}
}

/** Message from a failed provider lookup (fetchDetails throws SvelteKit HTTP errors). */
export function lookupFailure(e: unknown) {
	return (e as { body?: { message?: string } }).body?.message ?? (e as Error).message ?? 'Lookup failed';
}

/**
 * Connects an item to a metadata source entry: stores details, keeps the user's own title,
 * fills an empty subtitle/description, and adds the poster (cover if the item has none yet).
 */
export async function linkToProvider(userId: number, itemId: number, ref: ProviderRef) {
	const item = getItem(userId, itemId, 'edit');
	// Each owner has a source entry once, so the match is checked against the item owner's lists
	const existing = ownersItem(item.userId, ref.provider, ref.kind, ref.id);
	if (existing && existing !== itemId) {
		if (item.userId === userId) throw new MatchError('That one is already in your library.', existing);
		const { category } = getCategoryById(userId, item.categoryId);
		const other = db().select().from(schema.items).where(eq(schema.items.id, existing)).get();
		const visible = !!other && listAccess(userId, other.categoryId) !== null;
		throw visible
			? new MatchError(`That one is already in ${category.ownerName}'s library.`, existing)
			: new MatchError(hiddenClash(category.ownerName));
	}
	// Episode check-ins belong to the show they were made against
	const relink =
		item.providerId &&
		(item.provider !== ref.provider || item.providerKind !== ref.kind || item.providerId !== ref.id);
	if (
		relink &&
		db()
			.select({ id: schema.episodeWatches.id })
			.from(schema.episodeWatches)
			.where(eq(schema.episodeWatches.itemId, itemId))
			.get()
	) {
		throw new MatchError(
			'This show has episode check-ins, so it stays linked to the show they were made for.'
		);
	}
	const d = await fetchDetails(ref.provider, ref.kind, ref.id);
	updateItem(userId, itemId, {
		provider: ref.provider,
		providerKind: ref.kind,
		providerId: ref.id,
		subtitle: item.subtitle || d.subtitle || null,
		description: item.description || d.description || null,
		externalUrl: d.url ?? item.externalUrl,
		metadata: metadataToStore(d)
	});
	const art = d.largeImageUrl ?? d.imageUrl;
	if (art) await addImage(userId, { itemId }, { type: 'url', url: art, linkOnly: true });
	lookUpReleases(userId, itemId);
	return d;
}

/** A new show, movie or game shows up in the Calendar without waiting for the daily look-up. */
function lookUpReleases(userId: number, itemId: number) {
	refreshItemReleases(userId, itemId).catch(() => {
		/* the daily look-up tries again */
	});
}

/** Re-pulls provider data. Keeps the user's own title; refreshes description, subtitle and facts. */
export async function refreshMetadata(userId: number, itemId: number) {
	const item = getItem(userId, itemId, 'edit');
	if (!item.provider || !item.providerKind || !item.providerId)
		error(400, 'This item has no metadata source');
	const d = await fetchDetails(item.provider, item.providerKind, item.providerId);
	updateItem(userId, itemId, {
		subtitle: d.subtitle ?? item.subtitle,
		description: d.description ?? item.description,
		externalUrl: d.url ?? item.externalUrl,
		metadata: metadataToStore(d)
	});
	const art = d.largeImageUrl ?? d.imageUrl;
	if (art && !item.coverImageId) {
		await addImage(userId, { itemId }, { type: 'url', url: art, linkOnly: true });
	}
}
