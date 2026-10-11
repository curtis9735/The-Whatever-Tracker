import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { getProvider } from '../providers/registry';
import { ProviderError } from '../providers/util';
import { getCategoryById } from './categories';
import { addImage, addLog, createItem, getOwnedItem, updateItem } from './items';
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
	if (input.logDate) {
		addLog(
			userId,
			item.id,
			{ date: input.logDate, rating: input.rating, notes: input.logNotes ?? null },
			category.statuses
		);
	}
	reindexItem(item.id);
	return { id: item.id, created: true };
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
