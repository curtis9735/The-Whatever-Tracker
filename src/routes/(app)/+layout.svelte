<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import SearchOverlay from '$lib/components/SearchOverlay.svelte';
	import { categoryColor } from '$lib/kinds';
	import { searchUi } from '$lib/search-ui.svelte';

	let { data, children } = $props();

	const path = $derived(page.url.pathname);
	const isActive = (href: string) =>
		href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);

	function onKey(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
		if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
			e.preventDefault();
			searchUi.open = true;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="min-h-dvh md:pl-64">
	<!-- Desktop sidebar -->
	<aside class="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-border bg-surface md:flex">
		<a href="/" class="flex items-center gap-2 px-5 py-5 text-lg font-semibold tracking-tight">
			<span aria-hidden="true">🗃️</span> Whatever Tracker
		</a>
		<nav class="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
			<a href="/" class="nav-link" class:nav-active={isActive('/')}><Icon name="home" size={18} /> Home</a>
			<a href="/journal" class="nav-link" class:nav-active={isActive('/journal')}
				><Icon name="book" size={18} /> Journal</a
			>
			<button class="nav-link w-full" onclick={() => (searchUi.open = true)}>
				<Icon name="search" size={18} /> Search
				<kbd class="ml-auto rounded border border-border px-1.5 text-[10px] text-muted">Ctrl K</kbd>
			</button>
			<a href="/add" class="nav-link" class:nav-active={isActive('/add')}
				><Icon name="plus" size={18} /> Add</a
			>

			<p class="section-title mt-6 mb-2 px-3">Lists</p>
			{#each data.categories as c (c.id)}
				<a
					href="/c/{c.slug}"
					class="nav-link"
					class:nav-active={isActive(`/c/${c.slug}`)}
					style="--cat: {categoryColor(c.color)}"
				>
					<span class="w-5 text-center" aria-hidden="true">{c.icon}</span>
					<span class="truncate">{c.name}</span>
					<span class="ml-auto text-xs text-muted tabular-nums">{c.itemCount}</span>
				</a>
			{/each}
			<a href="/categories" class="nav-link text-muted" class:nav-active={isActive('/categories')}>
				<Icon name="settings" size={18} /> Manage lists
			</a>
		</nav>
		<div class="border-t border-border p-3">
			{#if data.user.isAdmin}
				<a href="/admin/users" class="nav-link" class:nav-active={isActive('/admin')}>
					<Icon name="shield" size={18} /> Household
				</a>
			{/if}
			<a href="/settings" class="nav-link" class:nav-active={isActive('/settings')}>
				<Icon name="user" size={18} />
				<span class="truncate">{data.user.displayName}</span>
			</a>
		</div>
	</aside>

	<!-- Top bar -->
	<header
		class="sticky top-0 z-10 border-b border-border bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-bg/70"
	>
		<div class="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:px-8">
			<a href="/" class="flex items-center gap-2 font-semibold md:hidden">
				<span aria-hidden="true">🗃️</span> Tracker
			</a>
			<button
				class="ml-auto flex min-h-10 flex-1 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-left text-sm text-muted hover:bg-surface-2 md:ml-0 md:max-w-md"
				onclick={() => (searchUi.open = true)}
			>
				<Icon name="search" size={18} />
				<span class="truncate">Search movies, games, whiskey…</span>
				<kbd class="ml-auto hidden rounded border border-border px-1.5 text-[10px] md:inline">/</kbd>
			</button>
			<a href="/add" class="btn btn-primary hidden md:inline-flex"><Icon name="plus" size={18} /> Add</a>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-4 pt-4 pb-28 md:px-8 md:pt-6 md:pb-12">
		{@render children()}
	</main>

	<!-- Mobile bottom navigation -->
	<nav
		class="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-safe backdrop-blur md:hidden"
		aria-label="Main"
	>
		<div class="mx-auto grid max-w-md grid-cols-5">
			<a href="/" class="tab" class:tab-active={isActive('/')}><Icon name="home" /><span>Home</span></a>
			<button class="tab" onclick={() => (searchUi.open = true)}
				><Icon name="search" /><span>Search</span></button
			>
			<a href="/add" class="tab" aria-label="Add">
				<span
					class="-mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg"
				>
					<Icon name="plus" size={28} />
				</span>
			</a>
			<a href="/categories" class="tab" class:tab-active={isActive('/categories') || path.startsWith('/c/')}>
				<Icon name="grid" /><span>Lists</span>
			</a>
			<a href="/settings" class="tab" class:tab-active={isActive('/settings') || isActive('/admin')}>
				<Icon name="user" /><span>Me</span>
			</a>
		</div>
	</nav>
</div>

<SearchOverlay
	bind:open={searchUi.open}
	categories={data.categories}
	searchKinds={data.searchKinds}
	setlistReady={data.setlistReady}
/>
