<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { monthLabel, shiftMonth } from '$lib/calendar';
	import { addDays, shortDate, WEEKDAYS, weekday } from '$lib/journal';
	import { categoryColor } from '$lib/kinds';

	let { data, form } = $props();

	const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const MAX_IN_CELL = 3;

	/** This page with some parameters changed (null removes one) */
	function hrefWith(changes: Record<string, string | null>, hash = '') {
		const sp = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) sp.delete(k);
			else sp.set(k, v);
		}
		const s = sp.toString();
		return `${s ? `?${s}` : page.url.pathname}${hash}`;
	}

	const byDay = $derived.by(() => {
		const map = new Map<string, typeof data.events>();
		for (const e of data.events) map.set(e.date, [...(map.get(e.date) ?? []), e]);
		return map;
	});
	/** Days of this month that have releases, for the list view */
	const listDays = $derived(
		[...byDay.keys()].filter((d) => d >= data.grid.first && d <= data.grid.last).sort()
	);
	const inMonth = (d: string) => d >= data.grid.first && d <= data.grid.last;
	const dayHref = (d: string) => hrefWith({ view: 'list', month: d.slice(0, 7) }, `#day-${d}`);

	function relative(d: string) {
		if (d === data.today) return 'Today';
		if (d === addDays(data.today, 1)) return 'Tomorrow';
		const days = Math.round((Date.parse(d) - Date.parse(data.today)) / 86_400_000);
		return days > 0 ? `In ${days} days` : '';
	}

	function checkedAgo(iso: string | null) {
		if (!iso) return 'Not checked yet';
		const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
		if (min < 1) return 'Checked just now';
		if (min < 60) return `Checked ${min} min ago`;
		const h = Math.round(min / 60);
		if (h < 24) return `Checked ${h} ${h === 1 ? 'hour' : 'hours'} ago`;
		const d = Math.round(h / 24);
		return `Checked ${d} ${d === 1 ? 'day' : 'days'} ago`;
	}

	let fetching = $state(false);
	let listsOpen = $state(false);
	let listsRoot = $state<HTMLDivElement>();
	const hiddenCount = $derived(data.lists.filter((l) => !l.shown).length);
	const linkedTotal = $derived(data.lists.reduce((n, l) => n + l.linked, 0));
</script>

<svelte:head><title>Calendar · The Whatever Tracker</title></svelte:head>

<svelte:window
	onclick={(e) => listsOpen && listsRoot && !listsRoot.contains(e.target as Node) && (listsOpen = false)}
	onkeydown={(e) => e.key === 'Escape' && (listsOpen = false)}
/>

<div class="space-y-5">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Calendar</h1>
		<p class="text-sm text-muted">Upcoming episodes, movies and games from your lists.</p>
	</div>

	{#if !data.ready}
		<div class="card p-5 text-sm">
			<p class="mb-1 font-medium">Connect a source to see release dates</p>
			<p class="text-muted">
				Air dates come from TMDB (TV shows and movies) and IGDB (video games). Connect them under
				<a class="text-accent underline" href="/settings#integrations">Me → Integrations</a>.
			</p>
		</div>
	{/if}

	<section class="card space-y-4 p-3 sm:p-5">
		<!-- Toolbar -->
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex items-center rounded-xl bg-surface-2">
				<a
					class="btn btn-ghost btn-icon"
					href={hrefWith({ month: shiftMonth(data.month, -1) })}
					aria-label="Previous month"
				>
					<Icon name="chevron-left" size={18} />
				</a>
				<h2 class="min-w-36 text-center font-semibold">{monthLabel(data.month)}</h2>
				<a
					class="btn btn-ghost btn-icon"
					href={hrefWith({ month: shiftMonth(data.month, 1) })}
					aria-label="Next month"
				>
					<Icon name="chevron-right" size={18} />
				</a>
			</div>
			<a class="btn btn-sm" href={hrefWith({ month: null })}>Today</a>

			<div class="ml-auto flex flex-wrap items-center gap-2">
				<form
					method="POST"
					action="?/refresh"
					use:enhance={() => {
						fetching = true;
						return async ({ update }) => {
							await update({ reset: false });
							fetching = false;
						};
					}}
				>
					<button class="btn btn-sm" disabled={fetching || !data.ready}>
						<Icon name="refresh" size={14} class={fetching ? 'animate-spin' : ''} />
						{fetching ? 'Looking up…' : 'Fetch new releases'}
					</button>
				</form>

				<div class="flex rounded-lg border border-border" role="group" aria-label="View">
					<a
						href={hrefWith({ view: null })}
						class="btn btn-ghost btn-sm rounded-r-none {data.view === 'grid' ? 'text-accent' : ''}"
						aria-label="Month grid"
						aria-current={data.view === 'grid' ? 'page' : undefined}><Icon name="grid" size={16} /></a
					>
					<a
						href={hrefWith({ view: 'list' })}
						class="btn btn-ghost btn-sm rounded-l-none {data.view === 'list' ? 'text-accent' : ''}"
						aria-label="List"
						aria-current={data.view === 'list' ? 'page' : undefined}><Icon name="list" size={16} /></a
					>
				</div>

				<!-- Which lists the calendar shows -->
				<div class="relative" bind:this={listsRoot}>
					<button
						type="button"
						class="btn btn-sm"
						aria-expanded={listsOpen}
						onclick={() => (listsOpen = !listsOpen)}
					>
						<Icon name="filter" size={14} /> Lists{hiddenCount ? ` (${hiddenCount} hidden)` : ''}
					</button>
					{#if listsOpen}
						<div
							class="absolute top-full right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-2 shadow-xl"
						>
							<p class="px-2 pt-1 pb-2 text-xs text-muted">Show releases from:</p>
							{#each data.lists as l (l.id)}
								<form method="POST" action="?/toggleList" use:enhance>
									<input type="hidden" name="categoryId" value={l.id} />
									<input type="hidden" name="shown" value={String(!l.shown)} />
									<button
										class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2"
										role="menuitemcheckbox"
										aria-checked={l.shown}
									>
										<span
											class="flex h-4 w-4 shrink-0 items-center justify-center rounded border {l.shown
												? 'border-accent bg-accent text-accent-fg'
												: 'border-border'}"
										>
											{#if l.shown}<Icon name="check" size={12} stroke={3} />{/if}
										</span>
										<span class="min-w-0 flex-1 truncate"
											>{l.icon}
											{l.name}{#if l.ownerName}<span class="text-muted">{` · ${l.ownerName}'s`}</span
												>{/if}</span
										>
										<span class="text-xs text-muted">{l.linked}</span>
									</button>
								</form>
							{:else}
								<p class="px-2 pb-2 text-sm">No lists hold shows, movies or games yet.</p>
							{/each}
							<p class="border-t border-border px-2 pt-2 text-xs text-muted">
								Also in each list's settings. Numbers are linked shows, movies and games.
							</p>
						</div>
					{/if}
				</div>

				<a
					class="btn btn-ghost btn-sm"
					href="/calendar/releases.ics"
					download
					aria-label="Download calendar file"
					title="Download the coming year as a calendar file (.ics) for Apple, Google or Outlook Calendar"
				>
					<Icon name="download" size={16} />
				</a>
			</div>
		</div>

		<p class="text-xs text-muted">
			{checkedAgo(data.checkedAt)}.
			{#if form && 'refreshed' in form && form.refreshed}
				Found {form.refreshed.releases} release dates for {form.refreshed.items}
				{form.refreshed.items === 1 ? 'title' : 'titles'}{form.refreshed.failed
					? `; ${form.refreshed.failed} couldn't be reached and will be tried again`
					: ''}.
			{/if}
			{#if form?.message}<span class="text-danger">{form.message}</span>{/if}
		</p>

		{#if data.view === 'grid'}
			<!-- Month grid -->
			<div class="grid grid-cols-7 gap-1 sm:gap-1.5">
				{#each WEEKDAY_SHORT as d (d)}
					<div class="pb-1 text-center text-xs font-medium text-muted">{d}</div>
				{/each}
				{#each data.grid.weeks.flat() as d (d)}
					{@const events = byDay.get(d) ?? []}
					{@const today = d === data.today}
					<div
						class="relative min-h-14 rounded-lg p-1 sm:min-h-28 sm:p-1.5 {inMonth(d)
							? 'bg-surface-2'
							: 'bg-surface-2/40 text-muted'} {today ? 'ring-2 ring-accent' : ''}"
					>
						<div class="mb-1 flex justify-end">
							<span
								class="flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold {today
									? 'bg-accent text-accent-fg'
									: ''}">{Number(d.slice(8))}</span
							>
						</div>
						{#if events.length}
							<!-- Phones: a dot per release, tap for the day -->
							<a
								href={dayHref(d)}
								class="flex flex-wrap justify-center gap-0.5 sm:hidden"
								aria-label="{shortDate(d)}: {events.length} releases"
							>
								{#each events.slice(0, 6) as e (e.id)}
									<span class="h-1.5 w-1.5 rounded-full" style="background: {categoryColor(e.categoryColor)}"
									></span>
								{/each}
							</a>
							<!-- Larger screens: the releases themselves -->
							<ul class="hidden space-y-0.5 sm:block">
								{#each events.slice(0, MAX_IN_CELL) as e (e.id)}
									<li>
										<a
											href="/items/{e.itemId}"
											class="flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-surface"
											title="{e.title} {e.label}{e.episodeTitle ? ` · ${e.episodeTitle}` : ''}"
										>
											<span aria-hidden="true">{e.categoryIcon}</span>
											<!-- The title gives way first, so "S5 E1" stays readable -->
											<span class="min-w-0 truncate">{e.title}</span>
											{#if e.kind === 'episode'}<span class="shrink-0 text-muted">{e.label}</span>{/if}
										</a>
									</li>
								{/each}
								{#if events.length > MAX_IN_CELL}
									<li>
										<a href={dayHref(d)} class="block px-1 text-xs font-medium text-accent hover:underline">
											+{events.length - MAX_IN_CELL} more
										</a>
									</li>
								{/if}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
			{#if data.ready && !data.events.some((e) => inMonth(e.date))}
				<p class="text-center text-sm text-muted">
					{data.checkedAt
						? `No releases in ${monthLabel(data.month)}.`
						: 'Press Fetch new releases to look up air dates for the shows, movies and games in your lists.'}
				</p>
			{/if}
		{:else}
			<!-- List view -->
			{#if !listDays.length}
				<p class="py-6 text-center text-sm text-muted">
					{data.checkedAt
						? `No releases in ${monthLabel(data.month)}.`
						: 'Press Fetch new releases to look up air dates for the shows, movies and games in your lists.'}
				</p>
			{:else}
				<div class="space-y-5">
					{#each listDays as d (d)}
						<section id="day-{d}" class="scroll-mt-24">
							<div class="mb-2 flex items-center gap-3">
								<h3 class="text-sm font-semibold {d === data.today ? 'text-accent' : ''}">
									{WEEKDAYS[weekday(d)]}, {shortDate(d)}
								</h3>
								{#if relative(d)}<span class="badge">{relative(d)}</span>{/if}
								<span class="h-px flex-1 bg-border"></span>
							</div>
							<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
								{#each byDay.get(d) ?? [] as e (e.id)}
									<a
										href="/items/{e.itemId}"
										class="flex gap-3 rounded-xl bg-surface-2 p-2.5 hover:bg-border/40"
									>
										<div
											class="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface text-xl"
										>
											{#if e.imageUrl}
												<img src={e.imageUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
											{:else}
												<span aria-hidden="true">{e.categoryIcon}</span>
											{/if}
										</div>
										<div class="min-w-0 flex-1">
											<p class="truncate font-medium">{e.title}</p>
											<p class="truncate text-sm">
												{e.label}{#if e.episodeTitle}<span class="text-muted"> · {e.episodeTitle}</span>{/if}
											</p>
											<p
												class="flex items-center gap-1.5 text-xs font-medium"
												style="color: {categoryColor(e.categoryColor)}"
											>
												<span class="h-1.5 w-1.5 rounded-full bg-current"></span>
												{e.categoryName}
											</p>
										</div>
									</a>
								{/each}
							</div>
						</section>
					{/each}
				</div>
			{/if}
		{/if}
	</section>

	{#if data.ready && data.lists.length && !linkedTotal}
		<p class="text-sm text-muted">
			Nothing in your lists is linked to TMDB or IGDB yet. Add shows, movies and games from the search bar, or
			use
			<strong>Find details on…</strong> on an item, and their dates show up here.
		</p>
	{/if}
</div>
