<script lang="ts">
	import { formatRating } from '$lib/ratings';
	import type { RatingScale } from '$lib/types';

	let {
		value,
		scale,
		class: cls = ''
	}: { value: number | null; scale: RatingScale; class?: string } = $props();
</script>

{#if value !== null && value !== undefined}
	<span class="inline-flex items-center font-semibold tabular-nums {cls}" title="Rating">
		{#if scale === '5star'}
			<span class="text-star">{formatRating(value, scale)}</span>
		{:else}
			{formatRating(value, scale)}
		{/if}
	</span>
{/if}
