<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { formatFieldValue } from '$lib/fields';
	import { imageSrc } from '$lib/images';
	import { categoryColor, PROVIDER_LABELS } from '$lib/kinds';
	import type { SetlistEvent, MetadataFact } from '$lib/types';
	import Icon from '$lib/components/Icon.svelte';
	import ImagePicker from '$lib/components/ImagePicker.svelte';
	import LogFields from '$lib/components/LogFields.svelte';
	import Rating from '$lib/components/Rating.svelte';
	import RatingInput from '$lib/components/RatingInput.svelte';
	import SetlistPicker from '$lib/components/SetlistPicker.svelte';

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
	const coverSrc = $derived(imageSrc(data.cover, 'full'));
	const statusLabel = $derived(cat.statuses.find((s) => s.key === item.status)?.label);
	const filledFields = $derived(
		data.itemFields.filter((f) => {
			const v = item.custom[f.key];
			return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
		})
	);
	const avgLogRating = $derived.by(() => {
		const r = data.logs.map((l) => l.rating).filter((x): x is number => x !== null);
		return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
	});

	let logOpen = $state(false);
	let logFormKey = $state(0);
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

	// Arriving with ?log=YYYY-MM-DD (e.g. right after adding an artist from search): open the
	// log form on that day and, for concerts, look the show up on setlist.fm straight away
	let pickerDate = $state<string | null>(null);
	$effect(() => {
		const d = data.openLogDate;
		if (!d) return;
		logOpen = true;
		logDate = d;
		pickerDate = d;
		tick().then(() =>
			document.getElementById('add-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
		);
	});

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	const isUrl = (s: string) => /^https?:\/\//.test(s);
</script>

<svelte:head><title>{item.title} · The Whatever Tracker</title></svelte:head>

<a href="/c/{cat.slug}" class="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
	<Icon name="chevron-left" size={16} />
	{cat.icon}
	{cat.name}
</a>

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
			<a href="/items/{item.id}/edit" class="btn btn-ghost btn-icon" aria-label="Edit"><Icon name="edit" /></a
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
					<Rating value={item.rating} scale={cat.ratingScale} />
				{:else}
					<span class="text-muted">Rate it</span>
				{/if}
			</button>
			{#if avgLogRating !== null && data.logs.length > 1}
				<span class="text-xs text-muted"
					>avg of logs: <Rating value={avgLogRating} scale={cat.ratingScale} /></span
				>
			{/if}
			<span class="text-sm text-muted">{data.logs.length} {data.logs.length === 1 ? 'log' : 'logs'}</span>
		</div>

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
				<RatingInput scale={cat.ratingScale} value={item.rating} label="Your rating" />
				<button class="btn btn-primary btn-sm">Save rating</button>
			</form>
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
				<h2 class="section-title mb-1">Notes</h2>
				<p class="text-sm whitespace-pre-line">{item.notes}</p>
			</div>
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
					{#if item.provider && PROVIDER_LABELS[item.provider]}
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
							</div>
						{/each}
					</div>
				{/if}
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
					<button class="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Uploading…' : 'Save photos'}</button
					>
				</form>
			</section>
		{/if}

		<!-- Logs -->
		<section class="mt-8">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-lg font-semibold">History</h2>
				<button class="btn btn-primary btn-sm" onclick={() => (logOpen = !logOpen)} aria-expanded={logOpen}>
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
									pickerDate = null;
									logFormKey++;
									// Drop ?log=… so a reload doesn't open the form again
									if (page.url.searchParams.has('log')) {
										goto(page.url.pathname, { replaceState: true, noScroll: true, keepFocus: true });
									}
								}
							};
						}}
					>
						{#if form?.logError}<p class="error-box">{form.logError}</p>{/if}
						{#if data.canSetlist}
							<SetlistPicker
								itemId={item.id}
								initialDate={pickerDate}
								bind:selected={setlist}
								onpick={onSetlist}
							/>
							<input type="hidden" name="log_external" value={setlist ? JSON.stringify({ setlist }) : ''} />
						{/if}
						<LogFields
							scale={cat.ratingScale}
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
					{#each data.logs as log (log.id)}
						{@const sl = (log.external as { setlist?: SetlistEvent } | null)?.setlist}
						<li class="relative">
							<span class="absolute top-1.5 -left-[27px] h-3 w-3 rounded-full border-2 border-bg bg-accent"
							></span>
							<div class="card p-4">
								<div class="flex items-start gap-3">
									<div class="min-w-0 flex-1">
										<p class="font-medium">{pretty(log.date)}</p>
										{#if log.location}
											<p class="flex items-center gap-1 text-sm text-muted">
												<Icon name="pin" size={14} />
												{log.location}
											</p>
										{/if}
									</div>
									<Rating value={log.rating} scale={cat.ratingScale} />
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
									<details class="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
										<summary class="cursor-pointer font-medium">
											<Icon name="music" size={14} class="inline" /> Setlist · {sl.songs.length} songs{sl.tour
												? ` · ${sl.tour}`
												: ''}
										</summary>
										<ol class="mt-2 list-decimal space-y-0.5 pl-6">
											{#each sl.songs as s, i (i)}
												<li>
													{s.name}{#if s.cover}<span class="text-muted">
															({s.cover} cover)</span
														>{/if}{#if s.set}<span class="text-xs text-muted"> · {s.set}</span>{/if}
												</li>
											{/each}
										</ol>
										{#if sl.url}<a
												class="mt-2 inline-block text-accent"
												href={sl.url}
												target="_blank"
												rel="noopener noreferrer">View on setlist.fm</a
											>{/if}
									</details>
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

		<form
			method="POST"
			action="?/delete"
			class="mt-12 border-t border-border pt-6"
			use:enhance={({ cancel }) => {
				if (!confirm(`Delete “${item.title}” and all its logs and photos? This cannot be undone.`)) cancel();
			}}
		>
			<button class="btn btn-ghost btn-sm text-danger"><Icon name="trash" size={14} /> Delete item</button>
		</form>
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
