<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { logEpisodeLabel, ownersProgressFields, PROGRESS_KEYS, type TrackerView } from '$lib/episodes';
	import { formatFieldValue } from '$lib/fields';
	import { imageSrc } from '$lib/images';
	import { categoryColor, PROVIDER_LABELS } from '$lib/kinds';
	import { setlistSections } from '$lib/setlists';
	import type { SetlistEvent, MetadataFact, SearchResult } from '$lib/types';
	import Icon from '$lib/components/Icon.svelte';
	import ImagePicker from '$lib/components/ImagePicker.svelte';
	import LogFields from '$lib/components/LogFields.svelte';
	import Rating from '$lib/components/Rating.svelte';
	import RatingInput from '$lib/components/RatingInput.svelte';
	import SetlistPicker from '$lib/components/SetlistPicker.svelte';
	import MetadataMatch from '$lib/components/MetadataMatch.svelte';
	import EpisodeSelect from '$lib/components/EpisodeSelect.svelte';
	import EpisodeTracker from '$lib/components/EpisodeTracker.svelte';
	import AlbumTracks from '$lib/components/AlbumTracks.svelte';
	import LogTracks from '$lib/components/LogTracks.svelte';
	import HouseholdProgress from '$lib/components/HouseholdProgress.svelte';
	import CheckInButton from '$lib/components/CheckInButton.svelte';
	import WatchCard from '$lib/components/WatchCard.svelte';
	import { runtimeFromFacts, watchKindOf } from '$lib/watching';

	let { data, form } = $props();

	const item = $derived(data.item);
	const cat = $derived(data.category);
	const meta = $derived(
		(item.metadata ?? null) as {
			genres?: string[];
			facts?: MetadataFact[];
			url?: string;
			year?: string;
		} | null
	);
	// Shared lists: anyone with access keeps their own status, rating, notes, logs and episodes;
	// changing the item itself (details, photos, links) takes edit access
	const canEdit = $derived(item.access !== 'view');
	const shared = $derived(cat.access !== 'owner' || cat.sharedWith > 0);
	const shareHint = $derived(
		cat.access !== 'owner'
			? `${cat.ownerName}'s list · ${cat.access === 'edit' ? 'you can edit' : 'view only'}`
			: cat.sharedWith > 0
				? `Shared with ${cat.sharedWith} ${cat.sharedWith === 1 ? 'person' : 'people'}`
				: null
	);
	const coverSrc = $derived(imageSrc(data.cover, 'full'));
	const statusLabel = $derived(cat.statuses.find((s) => s.key === item.status)?.label);
	const filledFields = $derived(
		data.itemFields.filter((f) => {
			// Shows linked to TMDB: the episode tracker shows progress; a saved current season/episode is the owner's
			const ownersProgress = cat.access !== 'owner' && ownersProgressFields(item, cat.providerKinds);
			if ((data.tracked || ownersProgress) && PROGRESS_KEYS.includes(f.key)) return false;
			const v = item.custom[f.key];
			return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
		})
	);
	// Movies: "Check in" (Watching now), or the viewer's check-in for it. Shows have theirs in the episode tracker.
	const isMovie = $derived(watchKindOf(item) === 'movie');
	const liveHere = $derived(data.watching.live?.itemId === item.id ? data.watching.live : null);
	const finishedHere = $derived(data.watching.finished?.itemId === item.id ? data.watching.finished : null);
	const avgLogRating = $derived.by(() => {
		const r = data.logs.map((l) => l.rating).filter((x): x is number => x !== null);
		return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
	});

	let logOpen = $state(false);
	let logFormKey = $state(0);

	// Episodes (shows linked to TMDB) are streamed in, so the page never waits for TMDB
	let tracker = $state<{ itemId: number; view: TrackerView } | null>(null);
	$effect(() => {
		const p = data.tracker;
		const id = data.item.id;
		if (!p) return;
		let live = true;
		p.then((view) => {
			if (live) tracker = { itemId: id, view };
		});
		return () => {
			live = false;
		};
	});
	const trackerView = $derived(tracker?.itemId === item.id ? tracker.view : null);
	const trackerSeasons = $derived(trackerView?.ok ? trackerView.seasons : []);
	/** Bumped after every episode change, so open seasons fetch their episodes again */
	let episodesVersion = $state(0);
	const statusGroup = $derived(cat.statuses.find((s) => s.key === item.status)?.group);
	let logSeason = $state<number | null>(null);
	let logEpisode = $state<number | null>(null);

	// Going straight to another item (e.g. from search) starts with its log form closed
	// svelte-ignore state_referenced_locally
	let shownItem = data.item.id;
	$effect(() => {
		if (data.item.id === shownItem) return;
		shownItem = data.item.id;
		logOpen = false;
		logSeason = null;
		logEpisode = null;
	});

	/** Opens "Add log", for an episode or (shows) the next one */
	async function openLog(pick?: { season: number; episode: number }) {
		const next = trackerView?.ok ? trackerView.next : null;
		logSeason = pick?.season ?? next?.season ?? null;
		logEpisode = pick?.episode ?? next?.episode ?? null;
		if (logOpen && pick) logFormKey++;
		logOpen = true;
		if (pick) {
			await tick();
			document.getElementById('add-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}
	let busy = $state(false);
	let editingRating = $state(false);
	let showGallery = $state(false);
	let lightbox = $state<string | null>(null);

	// Concert logs: picking a setlist fills date + venue
	let logDate = $state<string | undefined>(undefined);
	let logLocation = $state<string | undefined>(undefined);
	let setlist = $state<SetlistEvent | null>(null);

	function onSetlist(e: SetlistEvent | null) {
		if (e) {
			logDate = e.date;
			logLocation = [e.venue, e.city].filter(Boolean).join(', ');
		}
	}

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	/** "Mon, Oct 20", with the year when it isn't this one */
	function weekdayDate(d: string) {
		const date = new Date(`${d}T00:00:00`);
		return date.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
		});
	}

	const isUrl = (s: string) => /^https?:\/\//.test(s);

	// Items added by hand in a list with a metadata source can be matched afterwards
	const matchKinds = $derived(data.searchKinds.filter((k) => cat.providerKinds.includes(k)));
	const canLink = $derived(
		matchKinds.length > 0 &&
			!(item.provider && data.searchKinds.some((k) => k.startsWith(`${item.provider}:`)))
	);
	const linkSources = $derived(
		[...new Set(matchKinds.map((k) => PROVIDER_LABELS[k.split(':')[0]]))].join(' or ')
	);
	let linkOpen = $state(false);
	// svelte-ignore state_referenced_locally
	let linkQuery = $state(data.item.title);
	let linkMatch = $state<SearchResult | null>(null);
</script>

<svelte:head><title>{item.title} · The Whatever Tracker</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
	<a href="/c/{cat.slug}" class="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
		<Icon name="chevron-left" size={16} />
		{cat.icon}
		{cat.name}
	</a>
	{#if shareHint}
		<span class="inline-flex items-center gap-1 text-xs text-muted">
			<Icon name="user" size={12} />
			{shareHint}
		</span>
	{/if}
</div>

{#if data.warn}<p class="error-box mb-4">{data.warn}</p>{/if}
{#if form?.message}<p class="error-box mb-4">{form.message}</p>{/if}

<div class="grid gap-6 md:grid-cols-[minmax(0,280px)_1fr] lg:gap-10">
	<!-- Cover (a compact poster on phones so the title stays above the fold) -->
	<div class="mx-auto w-40 sm:w-52 md:w-full">
		<button
			type="button"
			class="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl bg-surface-2 text-6xl"
			style="--cat: {categoryColor(cat.color)}"
			onclick={() => coverSrc && (lightbox = coverSrc)}
			aria-label="View cover"
		>
			{#if coverSrc}
				<img src={coverSrc} alt="" class="h-full w-full object-cover" />
			{:else}
				<span aria-hidden="true">{cat.icon}</span>
			{/if}
		</button>
		<button type="button" class="btn btn-sm mt-2 w-full" onclick={() => (showGallery = !showGallery)}>
			<Icon name="image" size={16} /> Photos ({data.images.length})
		</button>
	</div>

	<!-- Main -->
	<div class="min-w-0">
		<div class="flex items-start gap-3">
			<div class="min-w-0 flex-1">
				<h1 class="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">{item.title}</h1>
				{#if item.subtitle}<p class="mt-1 text-muted">{item.subtitle}</p>{/if}
			</div>
			<form method="POST" action="?/favorite" use:enhance>
				<button
					class="btn btn-ghost btn-icon {item.favorite ? 'text-rose-500' : 'text-muted'}"
					aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
					aria-pressed={item.favorite}
				>
					<Icon name="heart" filled={item.favorite} />
				</button>
			</form>
			<!-- View only: the edit page has just their own status, rating, favorite and notes -->
			<a
				href="/items/{item.id}/edit"
				class="btn btn-ghost btn-icon"
				aria-label={canEdit ? 'Edit' : 'Edit your progress'}
				title={canEdit ? undefined : 'Your progress'}><Icon name="edit" /></a
			>
		</div>

		<div class="mt-4 flex flex-wrap items-center gap-3">
			<form method="POST" action="?/status" use:enhance>
				<select
					name="status"
					class="input min-h-9 w-auto rounded-full py-0 pr-8 text-sm font-medium"
					aria-label="Status"
					onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit()}
				>
					{#each cat.statuses as s (s.key)}<option value={s.key} selected={item.status === s.key}
							>{s.label}</option
						>{/each}
					{#if !item.status}<option value="" selected disabled>No status</option>{/if}
				</select>
			</form>
			<button
				type="button"
				class="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm hover:bg-surface-2"
				onclick={() => (editingRating = !editingRating)}
			>
				{#if item.rating !== null}
					<Rating value={item.rating} />
				{:else}
					<span class="text-muted">Rate it</span>
				{/if}
			</button>
			{#if avgLogRating !== null && data.logs.length > 1}
				<span class="text-xs text-muted">avg of logs: <Rating value={avgLogRating} /></span>
			{/if}
			<span class="text-sm text-muted">{data.logs.length} {data.logs.length === 1 ? 'log' : 'logs'}</span>
			{#if isMovie && !liveHere}
				<CheckInButton
					itemId={item.id}
					minutes={runtimeFromFacts(meta?.facts)}
					cls="btn btn-primary btn-sm"
				/>
			{/if}
		</div>

		{#if data.listening}
			<p class="mt-3 text-sm">
				<span aria-hidden="true">🎧</span>
				{'Your plays: ' + data.listening.plays.toLocaleString()}
				{#if data.listening.lastPlayed}
					<span class="text-muted">{' · last played ' + weekdayDate(data.listening.lastPlayed)}</span>
				{/if}
			</p>
		{/if}

		{#if isMovie && (liveHere || finishedHere)}
			<div class="mt-4">
				<WatchCard live={liveHere} finished={finishedHere} serverNow={data.watching.now} />
			</div>
		{/if}

		{#if editingRating}
			<form
				method="POST"
				action="?/rate"
				class="card mt-3 space-y-3 p-4"
				use:enhance={() =>
					async ({ update }) => {
						await update();
						editingRating = false;
					}}
			>
				<RatingInput value={item.rating} label="Your rating" />
				<button class="btn btn-primary btn-sm">Save rating</button>
			</form>
		{/if}

		{#if data.tracked}
			<!-- Keyed: another show starts with its own open seasons and messages -->
			{#key item.id}
				<EpisodeTracker
					itemId={item.id}
					tracker={trackerView}
					today={data.today}
					{statusGroup}
					version={episodesVersion}
					watching={data.watching}
					onchanged={() => episodesVersion++}
					onlog={(season, episode) => openLog({ season, episode })}
				/>
			{/key}
		{/if}

		{#if data.tags.length}
			<div class="mt-4 flex flex-wrap gap-1.5">
				{#each data.tags as t (t)}
					<a class="badge hover:text-fg" href="/c/{cat.slug}?tag={encodeURIComponent(t)}">#{t}</a>
				{/each}
			</div>
		{/if}

		{#if filledFields.length}
			<dl class="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
				{#each filledFields as f (f.key)}
					<div class={f.type === 'longtext' ? 'col-span-2 sm:col-span-3' : ''}>
						<dt class="text-xs text-muted">{f.label}</dt>
						<dd class="text-sm break-words whitespace-pre-line">
							{#if f.type === 'url'}
								<a
									class="text-accent underline"
									href={String(item.custom[f.key])}
									target="_blank"
									rel="noopener noreferrer"
								>
									{String(item.custom[f.key]).replace(/^https?:\/\//, '')}
								</a>
							{:else}
								{formatFieldValue(f, item.custom[f.key])}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		{/if}

		{#if item.notes}
			<div class="mt-5">
				<h2 class="section-title mb-1">{shared ? 'Your notes' : 'Notes'}</h2>
				<p class="text-sm whitespace-pre-line">{item.notes}</p>
			</div>
		{/if}

		{#if canLink && canEdit}
			<section class="card mt-5 p-4">
				{#if !linkOpen}
					<div class="flex flex-wrap items-center gap-3">
						<p class="flex-1 text-sm text-muted">No poster or details yet.</p>
						<button class="btn btn-primary btn-sm" onclick={() => (linkOpen = true)}>
							<Icon name="search" size={14} /> Find details on {linkSources}
						</button>
					</div>
				{:else}
					<form
						method="POST"
						action="?/link"
						class="space-y-3"
						use:enhance={() => {
							busy = true;
							return async ({ result, update }) => {
								await update();
								busy = false;
								if (result.type === 'success') linkOpen = false;
							};
						}}
					>
						<div>
							<label class="label" for="link-query">Look up</label>
							<input class="input" id="link-query" bind:value={linkQuery} autocomplete="off" />
						</div>
						<MetadataMatch kinds={matchKinds} query={linkQuery} bind:selected={linkMatch} />
						<div class="flex gap-2">
							<button class="btn btn-primary btn-sm" disabled={!linkMatch || busy}>
								{busy ? 'Loading details…' : 'Use this match'}
							</button>
							<button type="button" class="btn btn-sm" onclick={() => (linkOpen = false)}>Cancel</button>
						</div>
					</form>
				{/if}
				{#if form?.linkError}
					<p class="error-box mt-3">
						{form.linkError}
						{#if 'existingId' in form && form.existingId}
							<a class="font-medium underline" href="/items/{form.existingId}">Open it</a>
						{/if}
					</p>
				{/if}
			</section>
		{/if}

		{#if data.tracks && (data.tracks.tracks.length || data.tracks.also.length)}
			<AlbumTracks tracks={data.tracks} />
		{/if}

		{#if item.description || meta?.facts?.length}
			<details class="card mt-5 p-4" open={!data.logs.length}>
				<summary class="cursor-pointer text-sm font-medium">
					About{item.provider && PROVIDER_LABELS[item.provider]
						? ` · from ${PROVIDER_LABELS[item.provider]}`
						: ''}
				</summary>
				{#if meta?.genres?.length}
					<div class="mt-3 flex flex-wrap gap-1">
						{#each meta.genres as g (g)}<span class="badge">{g}</span>{/each}
					</div>
				{/if}
				{#if item.description}<p class="mt-3 text-sm whitespace-pre-line">{item.description}</p>{/if}
				{#if meta?.facts?.length}
					<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
						{#each meta.facts as f (f.label)}
							<dt class="text-muted">{f.label}</dt>
							<dd class="break-words">
								{#if isUrl(f.value)}
									<a class="text-accent underline" href={f.value} target="_blank" rel="noopener noreferrer"
										>{f.value.replace(/^https?:\/\//, '')}</a
									>
								{:else}{f.value}{/if}
							</dd>
						{/each}
					</dl>
				{/if}
				<div class="mt-4 flex flex-wrap gap-2">
					{#if item.externalUrl}
						<a class="btn btn-sm" href={item.externalUrl} target="_blank" rel="noopener noreferrer">
							<Icon name="external" size={14} /> Open source page
						</a>
					{/if}
					{#if canEdit && item.provider && PROVIDER_LABELS[item.provider]}
						<form
							method="POST"
							action="?/refresh"
							use:enhance={() => {
								busy = true;
								return async ({ update }) => {
									await update();
									busy = false;
								};
							}}
						>
							<button class="btn btn-sm" disabled={busy}
								><Icon name="refresh" size={14} /> {busy ? 'Refreshing…' : 'Refresh details'}</button
							>
						</form>
					{/if}
				</div>
			</details>
		{/if}

		{#if showGallery}
			<section class="card mt-5 p-4">
				<h2 class="section-title mb-3">Photos</h2>
				{#if data.images.length}
					<div class="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
						{#each data.images as img (img.id)}
							<div class="group relative">
								<button
									type="button"
									class="block aspect-square w-full overflow-hidden rounded-lg bg-surface-2"
									onclick={() => (lightbox = imageSrc(img, 'full'))}
								>
									<img src={imageSrc(img)} alt="" loading="lazy" class="h-full w-full object-cover" />
								</button>
								{#if canEdit}
									<div class="mt-1 flex gap-1">
										{#if data.cover?.id !== img.id}
											<form method="POST" action="?/cover" use:enhance>
												<input type="hidden" name="imageId" value={img.id} />
												<button class="btn btn-ghost btn-sm px-2" title="Use as cover">Cover</button>
											</form>
										{:else}
											<span class="badge">Cover</span>
										{/if}
										<form
											method="POST"
											action="?/deleteImage"
											use:enhance={({ cancel }) => {
												if (!confirm('Delete this photo?')) cancel();
											}}
										>
											<input type="hidden" name="imageId" value={img.id} />
											<button class="btn btn-ghost btn-sm px-2 text-danger" aria-label="Delete photo"
												><Icon name="trash" size={14} /></button
											>
										</form>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else if !canEdit}
					<p class="text-sm text-muted">No photos yet.</p>
				{/if}
				{#if canEdit}
					<form
						method="POST"
						action="?/addImages"
						enctype="multipart/form-data"
						class="space-y-3"
						use:enhance={() => {
							busy = true;
							return async ({ update }) => {
								await update();
								busy = false;
							};
						}}
					>
						{#if form?.imageError}<p class="error-box">{form.imageError}</p>{/if}
						<ImagePicker prefix="img_" label="Add photos" />
						<button class="btn btn-primary btn-sm" disabled={busy}
							>{busy ? 'Uploading…' : 'Save photos'}</button
						>
					</form>
				{/if}
			</section>
		{/if}

		{#if data.household.length}
			<!-- Everyone else with this list who has tracked it: their own status, rating, notes and logs -->
			<HouseholdProgress
				people={data.household}
				statuses={cat.statuses}
				logFields={data.logFields}
				tracked={data.tracked}
				serverNow={data.watching.now}
			/>
		{/if}

		<!-- Logs -->
		<section class="mt-8">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-lg font-semibold">{shared ? 'Your history' : 'History'}</h2>
				<button
					class="btn btn-primary btn-sm"
					onclick={() => (logOpen ? (logOpen = false) : openLog())}
					aria-expanded={logOpen}
				>
					<Icon name="plus" size={16} /> Add log
				</button>
			</div>

			{#if logOpen}
				{#key logFormKey}
					<form
						id="add-log"
						method="POST"
						action="?/addLog"
						enctype="multipart/form-data"
						class="card mb-5 scroll-mt-20 space-y-4 p-4"
						use:enhance={() => {
							busy = true;
							return async ({ result, update }) => {
								await update();
								busy = false;
								if (result.type === 'success') {
									logOpen = false;
									setlist = null;
									logDate = undefined;
									logLocation = undefined;
									logFormKey++;
									episodesVersion++;
								}
							};
						}}
					>
						{#if form?.logError}<p class="error-box">{form.logError}</p>{/if}
						{#if data.tracked}
							<EpisodeSelect
								seasons={trackerSeasons}
								episodesUrl={(s) => `/items/${item.id}/episodes?season=${s}`}
								bind:season={logSeason}
								bind:episode={logEpisode}
								noneLabel="No particular episode"
								id="log-episode"
							/>
						{/if}
						{#if data.canSetlist}
							<SetlistPicker itemId={item.id} bind:selected={setlist} onpick={onSetlist} />
							<input type="hidden" name="log_external" value={setlist ? JSON.stringify({ setlist }) : ''} />
						{/if}
						<LogFields
							logFields={data.logFields}
							dateDefault={data.today}
							bind:date={logDate}
							bind:location={logLocation}
							locationLabel={data.canSetlist ? 'Venue' : 'Where'}
						/>
						<ImagePicker prefix="logimg_" label="Photos" />
						<div class="flex gap-2">
							<button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save log'}</button>
							<button type="button" class="btn" onclick={() => (logOpen = false)}>Cancel</button>
						</div>
					</form>
				{/key}
			{/if}
			{#if form?.warning}<p class="error-box mb-3">{form.warning}</p>{/if}

			{#if data.logs.length === 0}
				<p class="text-sm text-muted">No logs yet. Add one each time you watch, play, taste or meet it.</p>
			{:else}
				<ol class="relative space-y-4 border-l-2 border-border pl-5">
					{#each data.logs as log, li (log.id)}
						{@const sl = (log.external as { setlist?: SetlistEvent } | null)?.setlist}
						{@const lfm = (log.external as { lastfm?: { plays: number } } | null)?.lastfm}
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
												<span>{logEpisodeLabel(log.episodes)}</span>
											</p>
										{/if}
										{#if lfm}
											<div class="mt-0.5">
												<LogTracks itemId={item.id} date={log.date} plays={lfm.plays} />
											</div>
										{/if}
										{#if log.location}
											<p class="flex items-center gap-1 text-sm text-muted">
												<Icon name="pin" size={14} />
												{log.location}
											</p>
										{/if}
									</div>
									<Rating value={log.rating} />
									<a href="/logs/{log.id}/edit" class="btn btn-ghost btn-sm px-2" aria-label="Edit log"
										><Icon name="edit" size={14} /></a
									>
								</div>
								{#each data.logFields.filter((f) => log.custom[f.key] !== undefined && log.custom[f.key] !== '') as f (f.key)}
									<p class="mt-2 text-sm">
										<span class="text-muted">{f.label}:</span>
										<span class="whitespace-pre-line">{formatFieldValue(f, log.custom[f.key])}</span>
									</p>
								{/each}
								{#if log.notes}<p class="mt-2 text-sm whitespace-pre-line">{log.notes}</p>{/if}
								{#if log.price !== null}<p class="mt-1 text-xs text-muted">Paid {log.price}</p>{/if}
								{#if sl}
									<!-- The newest show's setlist is open; older ones expand on tap -->
									<details class="mt-3 rounded-lg bg-surface-2 p-3 text-sm" open={li === 0}>
										<summary class="cursor-pointer font-medium">
											<Icon name="music" size={14} class="inline" />
											{sl.songs.length ? `Setlist · ${sl.songs.length} songs` : 'Setlist'}{sl.tour
												? ` · ${sl.tour}`
												: ''}
										</summary>
										{#each setlistSections(sl.songs) as sec, si (si)}
											{#if sec.label}
												<p class="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">
													{sec.label}
												</p>
											{/if}
											<ol class="mt-2 list-decimal space-y-0.5 pl-6" start={sec.songs[0].n}>
												{#each sec.songs as s (s.n)}
													<li>
														{s.name}{#if s.cover}<span class="text-muted">
																({s.cover} cover)</span
															>{/if}{#if s.info}<span class="text-xs text-muted"> · {s.info}</span>{/if}
													</li>
												{/each}
											</ol>
										{/each}
										{#if !sl.songs.length}
											<p class="mt-2 text-muted">
												setlist.fm has this show but no songs yet. Fans usually add them within a few days.
											</p>
										{/if}
										<div class="mt-3 flex flex-wrap items-center gap-3">
											{#if sl.url}<a
													class="text-accent"
													href={sl.url}
													target="_blank"
													rel="noopener noreferrer">View on setlist.fm</a
												>{/if}
											{#if data.canSetlist}
												<form method="POST" action="?/refreshSetlist" use:enhance>
													<input type="hidden" name="logId" value={log.id} />
													<button class="text-accent hover:underline">Check for updates</button>
												</form>
											{/if}
										</div>
									</details>
								{:else if data.canSetlist}
									<a href="/logs/{log.id}/edit" class="btn btn-sm mt-3">
										<Icon name="music" size={14} /> Find the setlist
									</a>
								{/if}
								{#if log.images.length}
									<div class="mt-3 flex flex-wrap gap-2">
										{#each log.images as img (img.id)}
											<button
												type="button"
												class="h-20 w-20 overflow-hidden rounded-lg bg-surface-2"
												onclick={() => (lightbox = imageSrc(img, 'full'))}
											>
												<img src={imageSrc(img)} alt="" loading="lazy" class="h-full w-full object-cover" />
											</button>
										{/each}
									</div>
								{/if}
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		{#if data.canDelete}
			<form
				method="POST"
				action="?/delete"
				class="mt-12 border-t border-border pt-6"
				use:enhance={({ cancel }) => {
					// Others who tracked it lose their progress too
					const what = data.household.length
						? 'its photos and everyone’s logs and progress'
						: 'all its logs and photos';
					if (!confirm(`Delete “${item.title}” and ${what}? This cannot be undone.`)) cancel();
				}}
			>
				<button class="btn btn-ghost btn-sm text-danger"><Icon name="trash" size={14} /> Delete item</button>
			</form>
		{:else if canEdit}
			<p class="mt-12 border-t border-border pt-6 text-sm text-muted">
				{data.household.length ? 'Others have' : 'Someone this list was shared with before has'} tracked this, so
				only {cat.ownerName} can delete it.
			</p>
		{/if}
	</div>
</div>

{#if lightbox}
	<button
		type="button"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
		onclick={() => (lightbox = null)}
		aria-label="Close photo"
	>
		<img src={lightbox} alt="" class="max-h-full max-w-full rounded-lg object-contain" />
	</button>
{/if}
