<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, subtitle, children }: { title: string; subtitle?: string; children: Snippet } = $props();
</script>

<main class="flex min-h-dvh items-center justify-center px-4 py-10">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<div class="mb-3 text-5xl" aria-hidden="true">🗃️</div>
			<h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
			{#if subtitle}<p class="mt-1 text-sm text-muted">{subtitle}</p>{/if}
		</div>
		<div class="card p-5 sm:p-6">
			{@render children()}
		</div>
		<p class="mt-6 text-center text-xs text-muted">The Whatever Tracker</p>
	</div>
</main>
