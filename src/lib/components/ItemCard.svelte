<script lang="ts">
	import { progressLabel } from '$lib/episodes';
	import { formatFieldValue } from '$lib/fields';
	import { imageSrc, type ImageRef } from '$lib/images';
	import type { FieldDef, StatusDef } from '$lib/types';
	import Icon from './Icon.svelte';
	import Rating from './Rating.svelte';

	let {
		item,
		statuses,
		cardFields,
		icon,
		view = 'grid'
	}: {
		item: {
			id: number;
			title: string;
			subtitle: string | null;
			status: string | null;
			rating: number | null;
			favorite: boolean;
			custom: Record<string, unknown>;
			logCount: number;
			lastLoggedAt: string | null;
			image: ImageRef | null;
		};
		statuses: StatusDef[];
		cardFields: FieldDef[];
		icon: string;
		view?: 'grid' | 'list';
	} = $props();

	const src = $derived(imageSrc(item.image));
	const statusLabel = $derived(statuses.find((s) => s.key === item.status)?.label ?? null);
	const extras = $derived.by(() => {
		const parts: string[] = [];
		const hasSeason = cardFields.some((f) => f.key === 'current_season');
		for (const f of cardFields) {
			// TV progress reads "S3 E5" rather than "3 · 5"
			if (f.key === 'current_episode' && hasSeason) continue;
			const v =
				f.key === 'current_season' ? progressLabel(item.custom) : formatFieldValue(f, item.custom[f.key]);
			if (v) parts.push(v);
		}
		return parts.join(' · ');
	});
	const lastLogged = $derived(
		item.lastLoggedAt
			? new Date(`${item.lastLoggedAt}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' })
			: ''
	);
	let broken = $state(false);
</script>

{#if view === 'grid'}
	<a href="/items/{item.id}" class="group block">
		<div
			class="relative mb-2 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-4xl"
		>
			{#if src && !broken}
				<img
					{src}
					alt=""
					loading="lazy"
					class="h-full w-full object-cover transition group-hover:scale-[1.02]"
					onerror={() => (broken = true)}
				/>
			{:else}
				<span aria-hidden="true">{icon}</span>
			{/if}
			{#if item.favorite}
				<span class="absolute top-2 right-2 rounded-full bg-black/50 p-1 text-rose-400">
					<Icon name="heart" size={14} filled />
				</span>
			{/if}
			{#if item.rating !== null}
				<span class="absolute bottom-2 left-2 rounded-lg bg-black/60 px-1.5 py-0.5 text-xs text-white">
					<Rating value={item.rating} />
				</span>
			{/if}
		</div>
		<p class="line-clamp-2 text-sm leading-snug font-medium">{item.title}</p>
		<p class="truncate text-xs text-muted">
			{[statusLabel, extras || item.subtitle].filter(Boolean).join(' · ')}
		</p>
	</a>
{:else}
	<a href="/items/{item.id}" class="flex items-center gap-3 p-3 hover:bg-surface-2">
		<div
			class="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-xl"
		>
			{#if src && !broken}
				<img {src} alt="" loading="lazy" class="h-full w-full object-cover" onerror={() => (broken = true)} />
			{:else}
				<span aria-hidden="true">{icon}</span>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<p class="truncate font-medium">
				{item.title}
				{#if item.favorite}<Icon name="heart" size={12} filled class="inline text-rose-500" />{/if}
			</p>
			{#if item.subtitle}<p class="truncate text-xs text-muted">{item.subtitle}</p>{/if}
			<p class="truncate text-xs text-muted">
				{[
					statusLabel,
					extras,
					item.logCount ? `${item.logCount} ${item.logCount === 1 ? 'log' : 'logs'}` : '',
					lastLogged ? `last ${lastLogged}` : ''
				]
					.filter(Boolean)
					.join(' · ')}
			</p>
		</div>
		<Rating value={item.rating} class="text-sm" />
	</a>
{/if}
