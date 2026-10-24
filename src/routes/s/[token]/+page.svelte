<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import SharedCard from '$lib/components/SharedCard.svelte';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();
	const list = $derived(data.list);

	/** Cards shown per section before "Show more", so a big list stays quick */
	const STEP = 60;

	let q = $state('');
	let sort = $state<'logged' | 'name' | 'rating'>('logged');
	let mainShown = $state(STEP);
	let plannedShown = $state(STEP);

	type Card = (typeof data.list.items)[number];
	const byName = (a: Card, b: Card) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
	const order = {
		logged: (a: Card, b: Card) => (b.lastLoggedAt ?? '').localeCompare(a.lastLoggedAt ?? '') || byName(a, b),
		name: byName,
		rating: (a: Card, b: Card) => (b.rating ?? -1) - (a.rating ?? -1) || byName(a, b)
	};

	const shown = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		const rows = needle
			? list.items.filter(
					(i) => i.title.toLowerCase().includes(needle) || (i.subtitle ?? '').toLowerCase().includes(needle)
				)
			: [...list.items];
		rows.sort(order[sort]);
		return { main: rows.filter((i) => !i.planned), planned: rows.filter((i) => i.planned) };
	});

	const count = $derived(list.itemCount === 1 ? '1 item' : `${list.itemCount} items`);
	const base = $derived(`/s/${data.token}`);
</script>

<svelte:head><title>{list.owner}'s {list.name}</title></svelte:head>

<header class="mb-6 flex items-center gap-3">
	<span
		class="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-3xl"
		style="background: color-mix(in srgb, {categoryColor(list.color)} 16%, transparent)"
		aria-hidden="true">{list.icon}</span
	>
	<div class="min-w-0">
		<h1 class="truncate text-2xl font-semibold tracking-tight">{list.name}</h1>
		<p class="text-sm text-muted">{`Shared by ${list.owner} · ${count}`}</p>
	</div>
</header>

{#if list.itemCount === 0}
	<p class="text-sm text-muted">Nothing in this list yet.</p>
{:else}
	<div class="mb-6 flex flex-col gap-2 sm:flex-row">
		<div class="relative flex-1">
			<Icon
				name="search"
				size={16}
				class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
			/>
			<input
				class="input pl-9"
				type="search"
				placeholder="Search this list"
				aria-label="Search this list"
				bind:value={q}
				oninput={() => {
					mainShown = plannedShown = STEP;
				}}
			/>
		</div>
		<select class="input sm:w-auto" aria-label="Sort by" bind:value={sort}>
			<option value="logged">Recently logged</option>
			<option value="name">Name</option>
			<option value="rating">Rating</option>
		</select>
	</div>

	{#if !shown.main.length && !shown.planned.length}
		<p class="text-sm text-muted">Nothing matches “{q.trim()}”.</p>
	{/if}

	{#if shown.main.length}
		<section>
			<div class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
				{#each shown.main.slice(0, mainShown) as item (item.id)}
					<SharedCard href="{base}/items/{item.id}" icon={list.icon} {item} />
				{/each}
			</div>
			{#if shown.main.length > mainShown}
				<button class="btn mt-5 w-full" onclick={() => (mainShown += STEP)}>
					{`Show more (${shown.main.length - mainShown} left)`}
				</button>
			{/if}
		</section>
	{/if}

	{#if shown.planned.length}
		<section class={shown.main.length ? 'mt-10' : ''}>
			<h2 class="section-title mb-3">{list.plannedLabel ?? 'Planned'}</h2>
			<div class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
				{#each shown.planned.slice(0, plannedShown) as item (item.id)}
					<SharedCard href="{base}/items/{item.id}" icon={list.icon} {item} />
				{/each}
			</div>
			{#if shown.planned.length > plannedShown}
				<button class="btn mt-5 w-full" onclick={() => (plannedShown += STEP)}>
					{`Show more (${shown.planned.length - plannedShown} left)`}
				</button>
			{/if}
		</section>
	{/if}
{/if}
