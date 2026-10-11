<script lang="ts">
	import { SCALES, toDisplay } from '$lib/ratings';
	import type { RatingScale } from '$lib/types';
	import Icon from './Icon.svelte';

	let {
		name = 'rating',
		scale,
		value = null,
		label = 'Rating',
		id = name
	}: {
		name?: string;
		scale: RatingScale;
		/** Stored 0–100 value */
		value?: number | null;
		label?: string;
		id?: string;
	} = $props();

	// Display-scale value (e.g. 3.5 stars); null = unrated. Seeded once; parents re-key to reset.
	// svelte-ignore state_referenced_locally
	let current = $state<number | null>(toDisplay(value, scale));
	const max = $derived(SCALES[scale].max);
	const step = $derived(SCALES[scale].step);

	function fillFor(i: number) {
		if (current === null) return 0;
		if (current >= i) return 1;
		if (current >= i - 0.5) return 0.5;
		return 0;
	}
</script>

<div>
	<div class="mb-1 flex items-center justify-between">
		<span class="label mb-0" id="{id}-label">{label}</span>
		{#if current !== null}
			<button type="button" class="text-xs text-muted hover:text-fg" onclick={() => (current = null)}>
				Clear
			</button>
		{/if}
	</div>
	<input type="hidden" {name} value={current ?? ''} />

	{#if scale === '5star'}
		<div class="flex items-center gap-1" role="group" aria-labelledby="{id}-label">
			{#each [1, 2, 3, 4, 5] as i (i)}
				<span class="relative inline-block h-9 w-9">
					<span class="absolute inset-0 text-border"><Icon name="star" size={36} filled stroke={1} /></span>
					<span
						class="absolute inset-0 overflow-hidden text-star"
						style="width: {fillFor(i) * 100}%"
						aria-hidden="true"
					>
						<Icon name="star" size={36} filled stroke={1} />
					</span>
					<button
						type="button"
						class="absolute inset-y-0 left-0 w-1/2"
						aria-label="{i - 0.5} stars"
						onclick={() => (current = i - 0.5)}
					></button>
					<button
						type="button"
						class="absolute inset-y-0 right-0 w-1/2"
						aria-label="{i} stars"
						onclick={() => (current = i)}
					></button>
				</span>
			{/each}
			<span class="ml-2 min-w-8 text-sm text-muted tabular-nums">{current ?? '–'}</span>
		</div>
	{:else}
		<div class="flex items-center gap-3">
			<input
				type="range"
				class="h-2 flex-1 accent-[var(--accent)]"
				min="0"
				{max}
				{step}
				value={current ?? max / 2}
				oninput={(e) => (current = Number((e.currentTarget as HTMLInputElement).value))}
				aria-labelledby="{id}-label"
			/>
			<input
				type="number"
				class="input w-20 text-center tabular-nums"
				min="0"
				{max}
				{step}
				placeholder="–"
				value={current ?? ''}
				oninput={(e) => {
					const v = (e.currentTarget as HTMLInputElement).value;
					current = v === '' ? null : Math.min(max, Math.max(0, Number(v)));
				}}
				aria-label="{label} out of {max}"
			/>
			<span class="text-sm text-muted">/ {max}</span>
		</div>
	{/if}
</div>
