<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import Rating from '$lib/components/Rating.svelte';
	import { shortDate, WEEKDAYS, weekday } from '$lib/journal';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();

	const keep = $derived<Record<string, string>>(data.list ? { list: data.list.slug } : {});

	/** The current address with some parameters changed (null removes one); "Show more" is reset. */
	function hrefWith(changes: Record<string, string | null>) {
		const sp = new URLSearchParams(page.url.searchParams);
		sp.delete('limit');
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) sp.delete(k);
			else sp.set(k, v);
		}
		const s = sp.toString();
		return s ? `?${s}` : page.url.pathname;
	}

	/** Clicking a day in the heatmap shows just that day */
	const dayHref = (date: string) => `?${new URLSearchParams({ from: date, to: date, ...keep })}`;

	const groups = $derived.by(() => {
		const out: { date: string; entries: typeof data.entries }[] = [];
		for (const e of data.entries) {
			const last = out.at(-1);
			if (last?.date === e.date) last.entries.push(e);
			else out.push({ date: e.date, entries: [e] });
		}
		return out;
	});

	const longDate = (iso: string) => `${WEEKDAYS[weekday(iso)]}, ${shortDate(iso)}`;
	const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

	// Heatmap shades: the theme's accent, stronger for busier days
	const SHADE = [0, 35, 55, 78, 100];
	const shade = (level: number) =>
		level ? `color-mix(in srgb, var(--accent) ${SHADE[level]}%, var(--surface-2))` : 'var(--surface-2)';
	const monthAt = $derived(new Map(data.heat.months.map((m) => [m.col, m.label])));
	const ROW_LABELS = ['Sun', '', 'Tue', '', 'Thu', '', 'Sat'];

	// Long ranges scroll sideways; start at the most recent weeks
	let heatEl = $state<HTMLDivElement>();
	$effect(() => {
		void data.heat;
		if (heatEl) heatEl.scrollLeft = heatEl.scrollWidth;
	});
</script>

<svelte:head><title>Journal · The Whatever Tracker</title></svelte:head>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Journal</h1>
		<p class="text-sm text-muted">Everything you've logged, day by day.</p>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<RangePicker range={data.range} today={data.today} {keep} />
		<select
			class="input min-h-10 w-auto"
			aria-label="Which lists"
			value={data.list?.slug ?? ''}
			onchange={(e) => goto(hrefWith({ list: (e.currentTarget as HTMLSelectElement).value || null }))}
		>
			<option value="">All lists</option>
			{#each page.data.categories as c (c.id)}
				<option value={c.slug}>{c.icon} {c.name}{c.ownerName ? ` (${c.ownerName}'s)` : ''}</option>
			{/each}
		</select>
	</div>

	<!-- Stats -->
	<div class="grid gap-3 sm:grid-cols-3">
		{@render stat(
			'activity',
			'var(--accent)',
			'Tracked activities',
			data.stats.total.toLocaleString(),
			data.stats.total ? `on ${days(data.stats.activeDays)}` : 'Nothing logged in this range'
		)}
		{@render stat(
			'calendar',
			'#10b981',
			'Most active day',
			data.stats.busiestDay?.name ?? '–',
			data.stats.busiestDay ? `${data.stats.busiestDay.percent}% of activity` : ''
		)}
		{@render stat(
			'flame',
			'#f43f5e',
			'Current streak',
			days(data.stats.currentStreak),
			`Longest in this range: ${days(data.stats.longestStreak)}`
		)}
	</div>

	<!-- Heatmap -->
	<section class="card p-4 sm:p-5">
		<h2 class="mb-3 font-semibold">Activity history</h2>
		<div class="overflow-x-auto pb-1" bind:this={heatEl}>
			<div class="inline-flex gap-[3px] text-[10px] leading-none text-muted">
				<div class="mr-1 grid grid-rows-[14px_repeat(7,13px)] gap-[3px]">
					<span></span>
					{#each ROW_LABELS as label, i (i)}<span class="flex items-center">{label}</span>{/each}
				</div>
				{#each data.heat.weeks as week, col (week[0].date)}
					<div class="grid grid-rows-[14px_repeat(7,13px)] gap-[3px]">
						<span class="w-[13px] overflow-visible whitespace-nowrap">{monthAt.get(col) ?? ''}</span>
						{#each week as cell (cell.date)}
							{#if cell.inRange}
								<!-- Empty days stay clickable but out of the keyboard's way -->
								<a
									href={dayHref(cell.date)}
									tabindex={cell.count ? undefined : -1}
									class="block h-[13px] w-[13px] rounded-[3px] outline-offset-1 hover:outline hover:outline-2 hover:outline-accent"
									style="background: {shade(cell.level)}"
									title="{shortDate(cell.date)}: {cell.count} {cell.count === 1 ? 'activity' : 'activities'}"
									aria-label="{shortDate(cell.date)}: {cell.count} {cell.count === 1
										? 'activity'
										: 'activities'}"
								></a>
							{:else}
								<span class="block h-[13px] w-[13px]"></span>
							{/if}
						{/each}
					</div>
				{/each}
			</div>
		</div>
		<div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
			<span>
				{#if data.heat.truncated}Showing the most recent five years.{:else}Click a day to see just that day.{/if}
			</span>
			<span class="flex items-center gap-1">
				Less
				{#each [0, 1, 2, 3, 4] as level (level)}
					<span class="block h-[13px] w-[13px] rounded-[3px]" style="background: {shade(level)}"></span>
				{/each}
				More
			</span>
		</div>
	</section>

	<!-- Feed -->
	{#if !data.entries.length}
		<div class="card p-8 text-center text-sm text-muted">
			<p class="mb-1 text-3xl" aria-hidden="true">📔</p>
			Nothing logged {data.range.key === 'custom' ? 'between these dates' : 'in this range'}{data.list
				? ` in ${data.list.name}`
				: ''}. Each time you add a log (a show you saw, a whiskey you tasted, a movie you watched) it appears
			here.
		</div>
	{:else}
		{#each groups as g (g.date)}
			<section>
				<div class="mb-3 flex items-center gap-3">
					<h2 class="text-sm font-semibold">{longDate(g.date)}</h2>
					<span class="h-px flex-1 bg-border"></span>
					<span class="text-xs text-muted">{g.entries.length}</span>
				</div>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each g.entries as e (e.id)}
						<a href="/items/{e.itemId}" class="card flex gap-3 p-3 hover:bg-surface-2">
							<div
								class="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-2xl"
							>
								{#if e.imageUrl}
									<img src={e.imageUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
								{:else}
									<span aria-hidden="true">{e.categoryIcon}</span>
								{/if}
							</div>
							<div class="min-w-0 flex-1 space-y-0.5">
								<p class="truncate font-semibold">{e.title}</p>
								<p
									class="flex items-center gap-1.5 text-xs font-medium"
									style="color: {categoryColor(e.categoryColor)}"
								>
									<span class="h-1.5 w-1.5 rounded-full bg-current"></span>
									{e.categoryName}
								</p>
								{#if e.episode}<p class="truncate text-sm">{e.episode}</p>{/if}
								{#if e.rating !== null}<Rating value={e.rating} class="text-sm" />{/if}
								{#if e.location}
									<p class="flex items-center gap-1 truncate text-xs text-muted">
										<Icon name="pin" size={12} />
										<span class="truncate">{e.location}</span>
									</p>
								{/if}
								{#if e.setlistSongs}
									<p class="flex items-center gap-1 text-xs text-muted">
										<Icon name="music" size={12} /> Setlist · {e.setlistSongs} songs
									</p>
								{/if}
								{#if e.notes}<p class="line-clamp-2 text-xs text-muted">{e.notes}</p>{/if}
							</div>
						</a>
					{/each}
				</div>
			</section>
		{/each}
		{#if data.more}
			<div class="text-center">
				<a class="btn" href={hrefWith({ limit: String(data.limit + 120) })} data-sveltekit-noscroll>
					Show more
				</a>
			</div>
		{/if}
	{/if}
</div>

{#snippet stat(icon: string, color: string, label: string, value: string, sub: string)}
	<div class="card flex items-center gap-4 p-4">
		<span
			class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
			style="color: {color}; background: color-mix(in srgb, {color} 16%, transparent)"
		>
			<Icon name={icon} size={22} />
		</span>
		<div class="min-w-0">
			<p class="text-sm text-muted">{label}</p>
			<p class="text-2xl font-semibold tracking-tight">{value}</p>
			{#if sub}<p class="truncate text-xs text-muted">{sub}</p>{/if}
		</div>
	</div>
{/snippet}
