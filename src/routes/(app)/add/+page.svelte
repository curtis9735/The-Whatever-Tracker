<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { categoryColor } from '$lib/kinds';
	import { openSearch } from '$lib/search-ui.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Add · The Whatever Tracker</title></svelte:head>

<h1 class="mb-5 text-2xl font-semibold tracking-tight">Add something</h1>

<div class="mb-8 grid gap-3 sm:grid-cols-2">
	<button class="card flex items-center gap-4 p-4 text-left hover:bg-surface-2" onclick={openSearch}>
		<span class="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
			<Icon name="search" size={24} />
		</span>
		<span>
			<span class="block font-medium">Search & add</span>
			<span class="text-sm text-muted">Movies, shows, games, board games, artists…</span>
		</span>
	</button>
	<a href="/add/scan" class="card flex items-center gap-4 p-4 hover:bg-surface-2">
		<span class="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
			<Icon name="barcode" size={24} />
		</span>
		<span>
			<span class="block font-medium">Scan a barcode</span>
			<span class="text-sm text-muted">Bottles, sauces, snacks…</span>
		</span>
	</a>
</div>

<h2 class="section-title mb-3">Or add by hand to…</h2>
{#if data.categories.length}
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
		{#each data.categories as c (c.id)}
			<a
				href="/items/new?category={c.slug}"
				class="card flex items-center gap-3 p-3 hover:bg-surface-2"
				style="--cat: {categoryColor(c.color)}"
			>
				<span
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl"
					style="background: color-mix(in srgb, var(--cat) 16%, transparent)"
					aria-hidden="true">{c.icon}</span
				>
				<span class="truncate font-medium">{c.name}</span>
			</a>
		{/each}
	</div>
{:else}
	<a class="btn btn-primary" href="/categories/new">Create a list first</a>
{/if}
