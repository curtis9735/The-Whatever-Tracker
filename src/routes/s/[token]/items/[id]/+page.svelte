<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Rating from '$lib/components/Rating.svelte';
	import { categoryColor } from '$lib/kinds';
	import { setlistSections } from '$lib/setlists';

	let { data } = $props();
	const item = $derived(data.item);
	const base = $derived(`/s/${data.token}`);
	const hero = $derived(item.images[0] ?? null);
	const whose = $derived(`${item.list.owner}'s ${item.list.name}`);

	let heroBroken = $state(false);

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	const plays = $derived(
		item.listening
			? `${item.listening.plays === 1 ? 'Played once' : `Played ${item.listening.plays} times`}${
					item.listening.lastPlayed ? ` · last ${pretty(item.listening.lastPlayed)}` : ''
				}`
			: ''
	);
	const setlistTitle = (sl: { songs: unknown[]; tour: string | null }) =>
		`${sl.songs.length ? `Setlist · ${sl.songs.length} songs` : 'Setlist'}${sl.tour ? ` · ${sl.tour}` : ''}`;
</script>

<svelte:head><title>{item.title} · {whose}</title></svelte:head>

<a href={base} class="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
	<Icon name="chevron-left" size={16} />
	{item.list.icon}
	{item.list.name}
</a>

<div class="space-y-8">
	<section class="flex gap-4 sm:gap-6">
		<div
			class="flex aspect-[3/4] w-32 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-surface-2 text-5xl sm:w-52"
			style="box-shadow: 0 0 0 1px color-mix(in srgb, {categoryColor(item.list.color)} 25%, transparent)"
		>
			{#if hero && !heroBroken}
				<a href={hero.full} target="_blank" rel="noopener noreferrer" class="block h-full w-full">
					<img
						src={hero.thumb}
						alt=""
						class="h-full w-full object-cover"
						onerror={() => (heroBroken = true)}
					/>
				</a>
			{:else}
				<span aria-hidden="true">{item.list.icon}</span>
			{/if}
		</div>
		<div class="min-w-0 flex-1 space-y-2">
			<h1 class="text-2xl leading-tight font-semibold tracking-tight">{item.title}</h1>
			{#if item.subtitle}<p class="text-muted">{item.subtitle}</p>{/if}
			<div class="flex flex-wrap items-center gap-2">
				{#if item.statusLabel}<span class="badge">{item.statusLabel}</span>{/if}
				{#if item.favorite}
					<span class="inline-flex items-center gap-1 text-sm text-rose-500">
						<Icon name="heart" size={14} filled /> Favorite
					</span>
				{/if}
				<Rating value={item.rating} class="text-lg" />
			</div>
			{#if item.genres.length || item.tags.length}
				<div class="flex flex-wrap gap-1.5">
					{#each item.genres as g, gi (gi)}<span class="badge">{g}</span>{/each}
					{#each item.tags as t, ti (ti)}<span class="chip">{`#${t}`}</span>{/each}
				</div>
			{/if}
			<p class="text-xs text-muted">{whose}</p>
		</div>
	</section>

	{#if item.description}
		<p class="text-sm leading-relaxed whitespace-pre-line">{item.description}</p>
	{/if}

	{#if item.notes}
		<section>
			<h2 class="section-title mb-2">Notes</h2>
			<div class="card p-4 text-sm whitespace-pre-line">{item.notes}</div>
		</section>
	{/if}

	{#if item.fields.length || item.facts.length}
		<section>
			<h2 class="section-title mb-2">Details</h2>
			<dl class="card divide-y divide-border text-sm">
				{#each item.fields as f, fi (fi)}
					<div class="flex gap-3 p-3">
						<dt class="w-2/5 shrink-0 text-muted sm:w-1/4">{f.label}</dt>
						<dd class="min-w-0 flex-1 break-words whitespace-pre-line">{f.value}</dd>
					</div>
				{/each}
				{#each item.facts as f, fi (fi)}
					<div class="flex gap-3 p-3">
						<dt class="w-2/5 shrink-0 text-muted sm:w-1/4">{f.label}</dt>
						<dd class="min-w-0 flex-1 break-words">{f.value}</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/if}

	{#if item.images.length > 1}
		<section>
			<h2 class="section-title mb-2">Photos</h2>
			<div class="flex flex-wrap gap-2">
				{#each item.images as img, ii (ii)}
					<a
						href={img.full}
						target="_blank"
						rel="noopener noreferrer"
						class="h-24 w-24 overflow-hidden rounded-lg bg-surface-2"
					>
						<img src={img.thumb} alt="" loading="lazy" class="h-full w-full object-cover" />
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2 class="section-title mb-3">History</h2>
		{#if plays}
			<p class="card mb-4 flex items-center gap-2 p-3 text-sm">
				<Icon name="music" size={14} class="shrink-0 text-accent" />
				{plays}
			</p>
		{/if}
		{#if item.logs.length === 0}
			{#if !plays}<p class="text-sm text-muted">Nothing logged yet.</p>{/if}
		{:else}
			<ol class="relative space-y-4 border-l-2 border-border pl-5">
				{#each item.logs as log, li (log.id)}
					<li class="relative">
						<span class="absolute top-1.5 -left-[27px] h-3 w-3 rounded-full border-2 border-bg bg-accent"
						></span>
						<div class="card p-4">
							<div class="flex items-start gap-3">
								<div class="min-w-0 flex-1">
									<p class="font-medium">{pretty(log.date)}</p>
									{#if log.episodes}
										<p class="flex items-center gap-1 text-sm">
											<Icon name="check" size={14} class="shrink-0 text-accent" />
											<span>{log.episodes}</span>
										</p>
									{/if}
									{#if log.location}
										<p class="flex items-center gap-1 text-sm text-muted">
											<Icon name="pin" size={14} class="shrink-0" />
											{log.location}
										</p>
									{/if}
								</div>
								<Rating value={log.rating} />
							</div>
							{#each log.fields as f, fi (fi)}
								<p class="mt-2 text-sm">
									<span class="text-muted">{f.label}:</span>
									<span class="whitespace-pre-line">{f.value}</span>
								</p>
							{/each}
							{#if log.notes}<p class="mt-2 text-sm whitespace-pre-line">{log.notes}</p>{/if}
							{#if log.price !== null}<p class="mt-1 text-xs text-muted">Paid {log.price}</p>{/if}
							{#if log.setlist}
								<!-- The newest show's setlist is open; older ones expand on tap -->
								<details class="mt-3 rounded-lg bg-surface-2 p-3 text-sm" open={li === 0}>
									<summary class="cursor-pointer font-medium">
										<Icon name="music" size={14} class="inline" />
										{setlistTitle(log.setlist)}
									</summary>
									{#each setlistSections(log.setlist.songs) as sec, si (si)}
										{#if sec.label}
											<p class="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">{sec.label}</p>
										{/if}
										<ol class="mt-2 list-decimal space-y-0.5 pl-6" start={sec.songs[0].n}>
											{#each sec.songs as s (s.n)}
												<li>
													{s.name}{#if s.cover}<span class="text-muted">{` (${s.cover} cover)`}</span
														>{/if}{#if s.info}<span class="text-xs text-muted">{` · ${s.info}`}</span>{/if}
												</li>
											{/each}
										</ol>
									{/each}
									{#if log.setlist.url}
										<a
											class="mt-3 inline-block text-accent"
											href={log.setlist.url}
											target="_blank"
											rel="noopener noreferrer">View on setlist.fm</a
										>
									{/if}
								</details>
							{/if}
							{#if log.images.length}
								<div class="mt-3 flex flex-wrap gap-2">
									{#each log.images as img, ii (ii)}
										<a
											href={img.full}
											target="_blank"
											rel="noopener noreferrer"
											class="h-20 w-20 overflow-hidden rounded-lg bg-surface-2"
										>
											<img src={img.thumb} alt="" loading="lazy" class="h-full w-full object-cover" />
										</a>
									{/each}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			{#if item.moreLogs > 0}
				<p class="mt-4 text-sm text-muted">
					{`and ${item.moreLogs} older ${item.moreLogs === 1 ? 'entry' : 'entries'}`}
				</p>
			{/if}
		{/if}
	</section>
</div>
