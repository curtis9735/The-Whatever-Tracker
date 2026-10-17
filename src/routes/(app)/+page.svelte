<script lang="ts">
	import { imageSrc } from '$lib/images';
	import { categoryColor } from '$lib/kinds';
	import Rating from '$lib/components/Rating.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { weekday } from '$lib/journal';
	import { logEpisodeLabel, parseLogEpisodes } from '$lib/episodes';

	let { data } = $props();
	const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	function img(r: {
		img_kind: 'upload' | 'url_copy' | 'url_link' | null;
		img_path: string | null;
		img_thumb: string | null;
		img_source: string | null;
	}) {
		return r.img_kind
			? imageSrc({ kind: r.img_kind, path: r.img_path, thumbPath: r.img_thumb, sourceUrl: r.img_source })
			: null;
	}

	function prettyDate(d: string) {
		const date = new Date(`${d}T00:00:00`);
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	/** " · S2 E5 · Title" for an episode check-in */
	function episodeLabel(ep: string) {
		const label = logEpisodeLabel(parseLogEpisodes(ep));
		return label ? ` · ${label}` : '';
	}

	const greeting = (() => {
		const h = new Date().getHours();
		return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
	})();
</script>

<svelte:head><title>Home · The Whatever Tracker</title></svelte:head>

<h1 class="mb-5 text-2xl font-semibold tracking-tight">{greeting}, {data.user.displayName}</h1>

{#if data.categories.length === 0}
	<div class="card p-6 text-center">
		<p class="mb-4">You have no lists yet.</p>
		<a class="btn btn-primary" href="/categories/new">Create your first list</a>
	</div>
{:else}
	<section class="mb-8">
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
			{#each data.categories as c (c.id)}
				<a
					href="/c/{c.slug}"
					class="card group flex items-center gap-3 p-3 transition hover:border-[var(--cat)]"
					style="--cat: {categoryColor(c.color)}"
				>
					<span
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl"
						style="background: color-mix(in srgb, var(--cat) 16%, transparent)"
						aria-hidden="true">{c.icon}</span
					>
					<span class="min-w-0">
						<span class="block truncate font-medium">{c.name}</span>
						<span class="block truncate text-xs text-muted"
							>{c.ownerName ? `${c.ownerName}'s · ` : ''}{c.itemCount}
							{c.itemCount === 1 ? 'item' : 'items'}</span
						>
					</span>
				</a>
			{/each}
		</div>
	</section>
{/if}

{#if data.comingUp.length}
	<section class="mb-8">
		<div class="mb-3 flex items-center justify-between gap-3">
			<h2 class="section-title">Coming up this week</h2>
			<a href="/calendar" class="flex items-center gap-1 text-sm text-accent hover:underline">
				<Icon name="calendar" size={14} /> Calendar
			</a>
		</div>
		<div class="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
			{#each data.comingUp as e (e.id)}
				<a href="/items/{e.itemId}" class="w-28 shrink-0">
					<div
						class="relative mb-1 flex aspect-[2/3] items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-3xl"
					>
						{#if e.imageUrl}
							<img src={e.imageUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
						{:else}
							<span aria-hidden="true">{e.categoryIcon}</span>
						{/if}
						<span
							class="absolute top-1.5 left-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white"
						>
							{e.date === data.today
								? 'Today'
								: `${WEEKDAY_SHORT[weekday(e.date)]} ${Number(e.date.slice(8))}`}
						</span>
					</div>
					<p class="truncate text-sm font-medium">{e.title}</p>
					<p class="truncate text-xs text-muted">{e.label}{e.episodeTitle ? ` · ${e.episodeTitle}` : ''}</p>
				</a>
			{/each}
		</div>
	</section>
{/if}

{#if data.upNext.length}
	{@render strip('Up next', data.upNext)}
{/if}
{#if data.favorites.length}
	{@render strip('Favorites', data.favorites)}
{/if}

<section>
	<div class="mb-3 flex items-center justify-between gap-3">
		<h2 class="section-title">Recent activity</h2>
		<a href="/journal" class="flex items-center gap-1 text-sm text-accent hover:underline">
			<Icon name="book" size={14} /> See all in Journal
		</a>
	</div>
	{#if data.activity.length === 0}
		<p class="text-sm text-muted">
			Nothing logged yet. Search for something you've watched, played or tasted and add a log.
		</p>
	{:else}
		<ul class="card divide-y divide-border">
			{#each data.activity as a (a.log_id)}
				<li>
					<a href="/items/{a.item_id}" class="flex items-center gap-3 p-3 hover:bg-surface-2">
						<div
							class="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2"
						>
							{#if img(a)}
								<img src={img(a)} alt="" loading="lazy" class="h-full w-full object-cover" />
							{:else}
								<span aria-hidden="true">{a.category_icon}</span>
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{a.title}</p>
							<p class="truncate text-xs text-muted">
								{a.category_icon}
								{prettyDate(a.date)}{episodeLabel(a.ep)}{a.location ? ` · ${a.location}` : ''}{a.notes
									? ` · ${a.notes}`
									: ''}
							</p>
						</div>
						<Rating value={a.log_rating} class="text-sm" />
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#snippet strip(title: string, rows: typeof data.upNext)}
	<section class="mb-8">
		<h2 class="section-title mb-3">{title}</h2>
		<div class="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
			{#each rows as r (r.id)}
				<a href="/items/{r.id}" class="w-28 shrink-0">
					<div
						class="mb-1 flex aspect-[2/3] items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-3xl"
					>
						{#if img(r)}
							<img src={img(r)} alt="" loading="lazy" class="h-full w-full object-cover" />
						{:else}
							<span aria-hidden="true">{r.category_icon}</span>
						{/if}
					</div>
					<p class="truncate text-sm font-medium">{r.title}</p>
					<p class="truncate text-xs text-muted">{r.category_icon} {r.category_name}</p>
				</a>
			{/each}
		</div>
	</section>
{/snippet}

{#if data.categories.length && data.activity.length === 0 && !data.upNext.length}
	<p class="mt-6 flex items-center gap-2 text-sm text-muted">
		<Icon name="sparkles" size={16} /> Tip: press <kbd class="rounded border border-border px-1">/</kbd> to search
		everything at once.
	</p>
{/if}
