<script lang="ts">
	import { RATING_MAX, toDisplay } from '$lib/ratings';

	let {
		name = 'rating',
		value = null,
		label = 'Rating',
		id = name
	}: {
		name?: string;
		/** Stored 0–100 value */
		value?: number | null;
		label?: string;
		id?: string;
	} = $props();

	// Whole number out of 10; null = unrated. Seeded once; parents re-key to reset.
	// svelte-ignore state_referenced_locally
	let current = $state<number | null>(toDisplay(value));
	const numbers = Array.from({ length: RATING_MAX }, (_, i) => i + 1);
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

	<div class="grid grid-cols-5 gap-1.5 sm:grid-cols-10" role="group" aria-labelledby="{id}-label">
		{#each numbers as n (n)}
			<button
				type="button"
				class="h-10 rounded-lg border text-sm font-semibold tabular-nums transition {current === n
					? 'border-accent bg-accent text-accent-fg'
					: 'border-border bg-surface hover:bg-surface-2'}"
				aria-pressed={current === n}
				aria-label="{n} out of {RATING_MAX}"
				onclick={() => (current = n)}
			>
				{n}
			</button>
		{/each}
	</div>
	<p class="mt-1 text-xs text-muted">{current === null ? 'Not rated' : `${current} out of ${RATING_MAX}`}</p>
</div>
