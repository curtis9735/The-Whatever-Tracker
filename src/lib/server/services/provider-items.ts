import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { getProvider } from '../providers/registry';
import { ProviderError } from '../providers/util';
import { getCategoryById } from './categories';
import { addImage, createItem, getOwnedItem, updateItem } from './items';
import { addLogWithShow, afterAddPath } from './concerts';
import { reindexItem } from '../search/local';
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

export function findExisting(userId: number, provider: string, kind: string, id: string) {
	return (
		db()
			.select({ id: schema.items.id })
			.from(schema.items)
			.where(
				and(
					eq(schema.items.userId, userId),
					eq(schema.items.provider, provider),
					eq(schema.items.providerKind, kind),
					eq(schema.items.providerId, id)
				)
			)
			.get()?.id ?? null
	);
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

	const { category } = getCategoryById(userId, input.categoryId);
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
	const item = getOwnedItem(userId, itemId);
	const existing = findExisting(userId, ref.provider, ref.kind, ref.id);
	if (existing && existing !== itemId) throw new MatchError('That one is already in your library.', existing);
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
	return d;
}

/** Re-pulls provider data. Keeps the user's own title; refreshes description, subtitle and facts. */
export async function refreshMetadata(userId: number, itemId: number) {
	const item = getOwnedItem(userId, itemId);
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
