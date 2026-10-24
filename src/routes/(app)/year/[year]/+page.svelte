<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Rating from '$lib/components/Rating.svelte';
	import { shortDate } from '$lib/journal';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();

	const r = $derived(data.review);
	const title = $derived(r.headline.soFar ? `${data.year} so far` : `${data.year} in review`);

	const MONTHS = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	];
	const num = (n: number) => n.toLocaleString();
	/** "1 album" / "3 albums", as one expression so Svelte's tag-edge trimming can't eat the space */
	const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
	const monthMax = $derived(Math.max(1, ...r.months));
	const range = (from: string, to: string) =>
		from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;

	// Each section has its own color; headline numbers are mixed toward the text color so they stay readable
	const SKY = categoryColor('sky');
	const TEAL = categoryColor('teal');
	const ROSE = categoryColor('rose');
	const bg = (c: string) =>
		`background: linear-gradient(135deg, color-mix(in srgb, ${c} 20%, var(--surface)), color-mix(in srgb, ${c} 5%, var(--surface))); border-color: color-mix(in srgb, ${c} 35%, var(--border))`;
	const ink = (c: string) => `color: color-mix(in srgb, ${c} 65%, var(--fg))`;

	const peak = $derived(r.highlights.busiestMonth);
</script>

<svelte:head><title>{title} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<!-- Year switcher -->
	<div class="flex items-center justify-between gap-2">
		<a
			class="btn btn-icon"
			class:pointer-events-none={data.older === null}
			class:opacity-40={data.older === null}
			aria-disabled={data.older === null}
			tabindex={data.older === null ? -1 : undefined}
			href={data.older === null ? undefined : `/year/${data.older}`}
			aria-label="Previous year"
		>
			<Icon name="chevron-left" size={18} />
		</a>
		<select
			class="input min-h-10 w-auto"
			aria-label="Year"
			value={String(data.year)}
			onchange={(e) => goto(`/year/${(e.currentTarget as HTMLSelectElement).value}`)}
		>
			{#each data.years as y (y)}
				<option value={String(y)}>{y}</option>
			{/each}
		</select>
		<a
			class="btn btn-icon"
			class:pointer-events-none={data.newer === null}
			class:opacity-40={data.newer === null}
			aria-disabled={data.newer === null}
			tabindex={data.newer === null ? -1 : undefined}
			href={data.newer === null ? undefined : `/year/${data.newer}`}
			aria-label="Next year"
		>
			<Icon name="chevron-right" size={18} />
		</a>
	</div>

	{#if data.empty}
		<div class="card p-8 text-center text-sm text-muted">
			<p class="mb-1 text-3xl" aria-hidden="true">🗓️</p>
			<h1 class="mb-1 text-xl font-semibold tracking-tight text-fg">{title}</h1>
			<p>
				Nothing logged in {data.year}{r.headline.soFar ? ' yet' : ''}. Each time you add a log (a show you
				saw, a whiskey you tasted, a movie you watched) it counts toward your year.
			</p>
			<a href="/journal" class="btn mt-4">Open the Journal</a>
		</div>
	{:else}
		<!-- The year in numbers -->
		<section class="rounded-3xl border p-5 sm:p-8" style={bg('var(--accent)')}>
			<p class="section-title">{r.headline.soFar ? 'So far' : 'The year'}</p>
			<h1 class="mt-1 text-4xl font-bold tracking-tight sm:text-5xl" style={ink('var(--accent)')}>
				{data.year}
			</h1>
			<p class="mt-1 text-sm text-muted">
				{r.headline.soFar ? 'Your year so far, in numbers.' : 'Your year, in numbers.'}
			</p>
			<dl class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
				{@render big(num(r.headline.logged), 'things logged', 'var(--accent)')}
				{@render big(
					num(r.headline.activeDays),
					r.headline.activeDays === 1 ? 'active day' : 'active days',
					'var(--accent)'
				)}
				{@render big(
					num(r.headline.lists),
					r.headline.lists === 1 ? 'list used' : 'lists used',
					'var(--accent)'
				)}
				{@render big(
					num(r.headline.newItems),
					r.headline.newItems === 1 ? 'new item' : 'new items',
					'var(--accent)'
				)}
			</dl>

			<!-- Month by month -->
			<h2 class="section-title mt-8 mb-3">Month by month</h2>
			<ol class="flex h-36 items-end gap-1 sm:gap-2" aria-label="Things logged in each month of {data.year}">
				{#each r.months as n, i (i)}
					<li
						class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
						aria-label="{MONTHS[i]}: {count(n, 'thing logged', 'things logged')}"
					>
						<span class="text-[10px] leading-none text-muted tabular-nums" aria-hidden="true">{n || ''}</span>
						<span
							class="w-full rounded-t-md"
							style="height: {n ? Math.max(4, Math.round((n / monthMax) * 100)) : 0}%; background: {n
								? `color-mix(in srgb, var(--accent) ${peak && peak.month === i + 1 ? 100 : 60}%, var(--surface-2))`
								: 'transparent'}"
						></span>
						<span class="h-px w-full bg-border" aria-hidden="true"></span>
						<span class="text-[10px] leading-none text-muted" aria-hidden="true">{MONTHS[i].slice(0, 3)}</span
						>
					</li>
				{/each}
			</ol>
		</section>

		<!-- Every list -->
		{#if r.lists.length}
			<h2 class="section-title pt-2">Every list</h2>
			{#each r.lists as l (l.id)}
				{@const c = categoryColor(l.color)}
				<section class="rounded-3xl border p-5" style={bg(c)}>
					<div class="flex items-center gap-3">
						<span
							class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-3xl"
							style="background: color-mix(in srgb, {c} 22%, transparent)"
							aria-hidden="true">{l.icon}</span
						>
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-xl font-semibold tracking-tight">
								<a href="/c/{l.slug}" class="hover:underline">{l.name}</a>
							</h3>
							<p class="text-sm text-muted">
								{count(l.logs, 'log', 'logs') + ' · ' + count(l.items, 'item', 'items')}
							</p>
						</div>
					</div>
					{#if l.topRated.length}
						<h4 class="section-title mt-5 mb-2">Top rated</h4>
						<div class="grid grid-cols-3 gap-3">
							{#each l.topRated as t (t.itemId)}
								{@render tile(t, c, false)}
							{/each}
						</div>
					{/if}
					{#if l.mostLogged[0] && l.mostLogged[0].count > 1}
						<h4 class="section-title mt-5 mb-2">Most logged</h4>
						<div class="grid grid-cols-3 gap-3 sm:grid-cols-5">
							{#each l.mostLogged as t (t.itemId)}
								{@render tile(t, c, true)}
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		{/if}

		<!-- Watching -->
		{#if r.watching}
			{@const w = r.watching}
			<section class="rounded-3xl border p-5 sm:p-8" style={bg(SKY)}>
				<p class="text-3xl" aria-hidden="true">🍿</p>
				<h2 class="mt-1 text-2xl font-bold tracking-tight">Watching</h2>
				<dl class="mt-5 grid grid-cols-3 gap-3">
					{@render big(num(w.movies), w.movies === 1 ? 'movie' : 'movies', SKY)}
					{@render big(num(w.episodes), w.episodes === 1 ? 'episode' : 'episodes', SKY)}
					{@render big(`${w.approximate ? '~' : ''}${num(w.hours)}`, w.hours === 1 ? 'hour' : 'hours', SKY)}
				</dl>
				<p class="mt-2 text-xs text-muted">
					Hours are approximate{w.approximate ? ': a usual length is assumed where none is known' : ''}.
				</p>
				{#if w.topShow}
					<h3 class="section-title mt-6 mb-2">Most watched show</h3>
					<a href="/items/{w.topShow.itemId}" class="card flex items-center gap-3 p-3 hover:bg-surface-2">
						<div
							class="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-2xl"
						>
							{#if w.topShow.coverUrl}
								<img src={w.topShow.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
							{:else}
								<span aria-hidden="true">📺</span>
							{/if}
						</div>
						<div class="min-w-0">
							<p class="truncate text-lg font-semibold">{w.topShow.title}</p>
							<p class="text-sm text-muted">{count(w.topShow.count, 'episode', 'episodes')}</p>
						</div>
					</a>
				{/if}
				{#if w.topMovies.length}
					<h3 class="section-title mt-6 mb-2">Top movies</h3>
					<div class="grid grid-cols-3 gap-3">
						{#each w.topMovies as t (t.itemId)}
							{@render tile(t, SKY, false)}
						{/each}
					</div>
				{/if}
				{#if w.busiestDay}
					<p class="mt-6 text-sm">
						<span class="text-muted">Busiest watching day</span>
						<span class="font-semibold">
							{' · ' +
								shortDate(w.busiestDay.date) +
								' · ' +
								w.busiestDay.count +
								(w.busiestDay.count === 1 ? ' watch' : ' watches')}
						</span>
					</p>
				{/if}
			</section>
		{/if}

		<!-- Music -->
		{#if r.music}
			{@const m = r.music}
			<section class="rounded-3xl border p-5 sm:p-8" style={bg(TEAL)}>
				<p class="text-3xl" aria-hidden="true">🎧</p>
				<h2 class="mt-1 text-2xl font-bold tracking-tight">Music</h2>
				<dl class="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
					{@render big(num(m.plays), m.plays === 1 ? 'play' : 'plays', TEAL)}
					{@render big(num(m.tracks), m.tracks === 1 ? 'track' : 'tracks', TEAL)}
					{@render big(num(m.albums), m.albums === 1 ? 'album' : 'albums', TEAL)}
					{@render big(num(m.artists), m.artists === 1 ? 'artist' : 'artists', TEAL)}
				</dl>

				<h3 class="section-title mt-6 mb-2">Top albums</h3>
				<div class="grid grid-cols-3 gap-3 sm:grid-cols-5">
					{#each m.topAlbums as a, i (i)}
						<svelte:element
							this={a.itemId ? 'a' : 'div'}
							href={a.itemId ? `/items/${a.itemId}` : undefined}
							class="block min-w-0"
						>
							<div
								class="relative mb-1 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-3xl"
							>
								{#if a.coverUrl}
									<img src={a.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
								{:else}
									<span aria-hidden="true">💿</span>
								{/if}
								<span
									class="absolute top-1 left-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white"
								>
									{i + 1}
								</span>
							</div>
							<p class="truncate text-sm font-medium">{a.title}</p>
							<p class="truncate text-xs text-muted">{a.artist}</p>
							<p class="text-xs text-muted">{count(a.plays, 'play', 'plays')}</p>
						</svelte:element>
					{/each}
				</div>

				<div class="mt-6 grid gap-6 sm:grid-cols-2">
					<div>
						<h3 class="section-title mb-2">Top artists</h3>
						<ol class="card divide-y divide-border">
							{#each m.topArtists as a, i (i)}
								<li class="flex items-center gap-3 p-2.5">
									<span class="w-5 text-center text-sm font-semibold text-muted tabular-nums">{i + 1}</span>
									<span
										class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2"
									>
										{#if a.coverUrl}
											<img src={a.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
										{:else}
											<span aria-hidden="true">🎤</span>
										{/if}
									</span>
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm font-medium">{a.artist}</span>
										<span class="block text-xs text-muted">{count(a.plays, 'play', 'plays')}</span>
									</span>
								</li>
							{/each}
						</ol>
					</div>
					{#if m.topTracks.length}
						<div>
							<h3 class="section-title mb-2">Top tracks</h3>
							<ol class="card divide-y divide-border">
								{#each m.topTracks as t, i (i)}
									<li class="flex items-center gap-3 p-2.5">
										<span class="w-5 text-center text-sm font-semibold text-muted tabular-nums">{i + 1}</span>
										<span
											class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2"
										>
											{#if t.coverUrl}
												<img src={t.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
											{:else}
												<span aria-hidden="true">🎵</span>
											{/if}
										</span>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium">{t.name}</span>
											<span class="block truncate text-xs text-muted">
												{(t.artist ? t.artist + ' · ' : '') + count(t.plays, 'play', 'plays')}
											</span>
										</span>
									</li>
								{/each}
							</ol>
						</div>
					{/if}
				</div>

				<div class="mt-6 grid gap-3 sm:grid-cols-2">
					<div class="card p-3">
						<p class="section-title">Biggest listening day</p>
						<p class="text-lg font-semibold">{shortDate(m.biggestDay.date)}</p>
						<p class="text-sm text-muted">{count(m.biggestDay.plays, 'play', 'plays')}</p>
					</div>
					<div class="card p-3">
						<p class="section-title">Most listened month</p>
						<p class="text-lg font-semibold">{MONTHS[m.busiestMonth.month - 1]}</p>
						<p class="text-sm text-muted">{count(m.busiestMonth.plays, 'play', 'plays')}</p>
					</div>
				</div>
			</section>
		{/if}

		<!-- Highlights -->
		{@const h = r.highlights}
		<section class="rounded-3xl border p-5 sm:p-8" style={bg(ROSE)}>
			<p class="text-3xl" aria-hidden="true">✨</p>
			<h2 class="mt-1 text-2xl font-bold tracking-tight">Highlights</h2>
			<div class="mt-5 grid gap-3 sm:grid-cols-2">
				{#if h.longestStreak}
					<div class="card p-3">
						<p class="section-title">Longest streak</p>
						<p class="text-lg font-semibold" style={ink(ROSE)}>
							{count(h.longestStreak.days, 'day', 'days')}
						</p>
						<p class="text-sm text-muted">{range(h.longestStreak.from, h.longestStreak.to)}</p>
					</div>
				{/if}
				{#if h.busiestMonth}
					<div class="card p-3">
						<p class="section-title">Busiest month</p>
						<p class="text-lg font-semibold" style={ink(ROSE)}>{MONTHS[h.busiestMonth.month - 1]}</p>
						<p class="text-sm text-muted">{count(h.busiestMonth.count, 'thing logged', 'things logged')}</p>
					</div>
				{/if}
				{#if h.busiestDay}
					<div class="card p-3">
						<p class="section-title">Busiest day</p>
						<p class="text-lg font-semibold" style={ink(ROSE)}>{shortDate(h.busiestDay.date)}</p>
						<p class="text-sm text-muted">{count(h.busiestDay.count, 'thing logged', 'things logged')}</p>
					</div>
				{/if}
				{#if h.newPlaces}
					<div class="card p-3">
						<p class="section-title">New places</p>
						<p class="text-lg font-semibold" style={ink(ROSE)}>{num(h.newPlaces)}</p>
						<p class="text-sm text-muted">never logged anywhere before</p>
					</div>
				{/if}
				{#if h.newArtists}
					<div class="card p-3">
						<p class="section-title">New artists</p>
						<p class="text-lg font-semibold" style={ink(ROSE)}>{num(h.newArtists)}</p>
						<p class="text-sm text-muted">seen or heard for the first time</p>
					</div>
				{/if}
				{#if h.topRated}
					<a
						href="/items/{h.topRated.itemId}"
						class="card flex items-center gap-3 p-3 hover:bg-surface-2 sm:col-span-2"
					>
						<div
							class="flex h-20 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-2xl"
						>
							{#if h.topRated.coverUrl}
								<img src={h.topRated.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
							{:else}
								<span aria-hidden="true">{h.topRated.listIcon}</span>
							{/if}
						</div>
						<div class="min-w-0">
							<p class="section-title">Highest rated</p>
							<p class="truncate text-lg font-semibold">{h.topRated.title}</p>
							<p class="truncate text-sm text-muted">
								{h.topRated.listIcon + ' ' + h.topRated.listName + ' · ' + shortDate(h.topRated.date)}
							</p>
							<Rating value={h.topRated.rating} class="text-sm" />
						</div>
					</a>
				{/if}
				{#if h.first}
					{@render logCard('First thing you logged', h.first)}
				{/if}
				{#if h.last}
					{@render logCard(r.headline.soFar ? 'Latest thing you logged' : 'Last thing you logged', h.last)}
				{/if}
			</div>
		</section>
	{/if}
</div>

{#snippet big(value: string, label: string, color: string)}
	<div class="flex min-w-0 flex-col">
		<dt class="order-2 text-sm text-muted">{label}</dt>
		<dd class="order-1 text-3xl font-bold tracking-tight tabular-nums sm:text-4xl" style={ink(color)}>
			{value}
		</dd>
	</div>
{/snippet}

{#snippet tile(
	t: { itemId: number; title: string; coverUrl: string | null; rating: number | null; count: number },
	color: string,
	showCount: boolean
)}
	<a href="/items/{t.itemId}" class="block min-w-0">
		<div
			class="relative mb-1 flex aspect-[2/3] items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-3xl"
			style="box-shadow: 0 0 0 2px color-mix(in srgb, {color} 30%, transparent)"
		>
			{#if t.coverUrl}
				<img src={t.coverUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
			{:else}
				<span aria-hidden="true">🗃️</span>
			{/if}
			{#if showCount && t.count > 1}
				<span
					class="absolute top-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white"
				>
					{'×' + t.count}
				</span>
			{/if}
		</div>
		<p class="truncate text-sm font-medium">{t.title}</p>
		{#if t.rating !== null}<Rating value={t.rating} class="text-xs" />{/if}
	</a>
{/snippet}

{#snippet logCard(
	label: string,
	e: { itemId: number; title: string; date: string; listName: string; listIcon: string }
)}
	<a href="/items/{e.itemId}" class="card block p-3 hover:bg-surface-2">
		<p class="section-title">{label}</p>
		<p class="truncate text-lg font-semibold">{e.title}</p>
		<p class="truncate text-sm text-muted">{e.listIcon + ' ' + e.listName + ' · ' + shortDate(e.date)}</p>
	</a>
{/snippet}
