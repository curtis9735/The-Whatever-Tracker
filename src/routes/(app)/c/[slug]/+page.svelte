<script lang="ts">
	import { page } from '$app/state';
	import ItemCard from '$lib/components/ItemCard.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();
	const c = $derived(data.category);
	const f = $derived(data.filters);
	let showFilters = $state(false);

	/** Builds a URL from the current params with some changed (null removes; page resets). */
	function withParams(changes: Record<string, string | null>) {
		const sp = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') sp.delete(k);
			else sp.set(k, v);
		}
		if (!('page' in changes)) sp.delete('page');
		const s = sp.toString();
		return s ? `?${s}` : page.url.pathname;
	}

	const totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const activeFilters = $derived([f.tag, f.min, f.fav ? '1' : '', f.q, f.value].filter(Boolean).length);
</script>

<svelte:head><title>{c.name} · The Whatever Tracker</title></svelte:head>

<div class="mb-4 flex items-center gap-3">
	<span
		class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl"
		style="background: color-mix(in srgb, {categoryColor(c.color)} 16%, transparent)"
		aria-hidden="true">{c.icon}</span
	>
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-2xl font-semibold tracking-tight">{c.name}</h1>
		<p class="text-sm text-muted">{data.total} {data.total === 1 ? 'item' : 'items'}</p>
	</div>
	<a
		href="/c/{c.slug}/import"
		class="btn btn-ghost btn-icon"
		aria-label="Import a spreadsheet"
		title="Import a spreadsheet"
	>
		<Icon name="upload" />
	</a>
	<a
		href="/categories/{c.slug}/edit"
		class="btn btn-ghost btn-icon"
		aria-label="Edit list settings"
		title="Edit list"
	>
		<Icon name="settings" />
	</a>
	<a href="/items/new?category={c.slug}" class="btn btn-primary"
		><Icon name="plus" size={18} /><span class="hidden sm:inline">Add</span></a
	>
</div>

<!-- Status chips -->
<div class="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
	<a href={withParams({ status: null, group: null })} class="chip" class:chip-active={!f.status && !f.group}
		>All</a
	>
	{#each c.statuses as s (s.key)}
		<a
			href={withParams({ status: f.status === s.key ? null : s.key, group: null })}
			class="chip"
			class:chip-active={f.status === s.key}
		>
			{s.label}
			<span class="text-muted tabular-nums">{data.statusCounts[s.key] ?? 0}</span>
		</a>
	{/each}
</div>

<div class="mb-4 flex flex-wrap items-center gap-2">
	<button class="btn btn-sm" onclick={() => (showFilters = !showFilters)} aria-expanded={showFilters}>
		<Icon name="filter" size={14} /> Filters{activeFilters ? ` (${activeFilters})` : ''}
	</button>
	<form method="GET" class="contents" data-sveltekit-keepfocus data-sveltekit-replacestate>
		{#each [...page.url.searchParams].filter(([k]) => !['sort', 'page'].includes(k)) as [k, v] (k)}
			<input type="hidden" name={k} value={v} />
		{/each}
		<select
			name="sort"
			class="input min-h-8 w-auto rounded-lg py-0 text-xs"
			aria-label="Sort"
			onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit()}
		>
			<option value="recent" selected={f.sort === 'recent'}>Recently updated</option>
			<option value="logged" selected={f.sort === 'logged'}>Recently logged</option>
			<option value="rating" selected={f.sort === 'rating'}>Highest rated</option>
			<option value="title" selected={f.sort === 'title'}>Title A–Z</option>
			<option value="added" selected={f.sort === 'added'}>Date added</option>
		</select>
	</form>
	<div class="ml-auto flex rounded-lg border border-border">
		<a
			href={withParams({ view: null, page: String(data.page) })}
			class="btn btn-ghost btn-sm rounded-r-none"
			class:text-accent={data.view === 'grid'}
			aria-label="Grid view"><Icon name="grid" size={16} /></a
		>
		<a
			href={withParams({ view: 'list', page: String(data.page) })}
			class="btn btn-ghost btn-sm rounded-l-none"
			class:text-accent={data.view === 'list'}
			aria-label="List view"><Icon name="list" size={16} /></a
		>
	</div>
</div>

{#if showFilters}
	<form
		method="GET"
		class="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
		data-sveltekit-replacestate
	>
		{#if f.status}<input type="hidden" name="status" value={f.status} />{/if}
		{#if data.view === 'list'}<input type="hidden" name="view" value="list" />{/if}
		<input type="hidden" name="sort" value={f.sort} />
		<div>
			<label class="label" for="flt-q">Title contains</label>
			<input class="input" id="flt-q" name="q" value={f.q} />
		</div>
		{#if data.tags.length}
			<div>
				<label class="label" for="flt-tag">Tag</label>
				<select class="input" id="flt-tag" name="tag">
					<option value="">Any</option>
					{#each data.tags as t (t)}<option value={t} selected={f.tag === t}>{t}</option>{/each}
				</select>
			</div>
		{/if}
		<div>
			<label class="label" for="flt-min">Minimum rating (out of 10)</label>
			<input class="input" id="flt-min" name="min" type="number" step="1" min="1" max="10" value={f.min} />
		</div>
		{#if data.filterable.length}
			<div>
				<label class="label" for="flt-field">Field</label>
				<div class="flex gap-2">
					<select class="input" id="flt-field" name="field">
						{#each data.filterable as fd (fd.key)}
							<option value={fd.key} selected={f.field === fd.key}>{fd.label}</option>
						{/each}
					</select>
					<input class="input" name="value" placeholder="value" value={f.value} aria-label="Field value" />
				</div>
			</div>
		{/if}
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="fav" value="1" checked={f.fav} class="h-4 w-4 accent-[var(--accent)]" />
			Favorites only
		</label>
		<div class="flex gap-2 sm:col-span-2 lg:col-span-4">
			<button class="btn btn-primary btn-sm">Apply</button>
			<a class="btn btn-sm" href={page.url.pathname}>Reset</a>
		</div>
	</form>
{/if}

{#if data.rows.length === 0}
	<div class="card p-8 text-center">
		<p class="mb-1 text-3xl" aria-hidden="true">{c.icon}</p>
		<p class="mb-4 text-sm text-muted">
			{data.total === 0 && !activeFilters && !f.status
				? `No ${c.name.toLowerCase()} yet.`
				: 'Nothing matches these filters.'}
		</p>
		<div class="flex flex-wrap justify-center gap-2">
			<a class="btn btn-primary" href="/items/new?category={c.slug}"><Icon name="plus" size={18} /> Add one</a
			>
			{#if data.total === 0 && !activeFilters && !f.status}
				<a class="btn" href="/c/{c.slug}/import"
					><Icon name="upload" size={16} /> Have a spreadsheet? Import it</a
				>
			{/if}
		</div>
	</div>
{:else if data.view === 'grid'}
	<div class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
		{#each data.rows as item (item.id)}
			<ItemCard {item} statuses={c.statuses} cardFields={data.cardFields} icon={c.icon} />
		{/each}
	</div>
{:else}
	<div class="card divide-y divide-border overflow-hidden">
		{#each data.rows as item (item.id)}
			<ItemCard {item} statuses={c.statuses} cardFields={data.cardFields} icon={c.icon} view="list" />
		{/each}
	</div>
{/if}

{#if totalPages > 1}
	<nav class="mt-8 flex items-center justify-center gap-3" aria-label="Pages">
		{#if data.page > 1}
			<a class="btn btn-sm" href={withParams({ page: String(data.page - 1) })}>Previous</a>
		{/if}
		<span class="text-sm text-muted">Page {data.page} of {totalPages}</span>
		{#if data.page < totalPages}
			<a class="btn btn-sm" href={withParams({ page: String(data.page + 1) })}>Next</a>
		{/if}
	</nav>
{/if}
