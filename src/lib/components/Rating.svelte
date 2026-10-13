<script lang="ts">
	import { formatRating } from '$lib/ratings';

	let { value, class: cls = '' }: { value: number | null; class?: string } = $props();
</script>

{#if value !== null && value !== undefined}
	<span class="inline-flex items-center font-semibold tabular-nums {cls}" title="Rating">
		{formatRating(value)}
	</span>
{/if}
