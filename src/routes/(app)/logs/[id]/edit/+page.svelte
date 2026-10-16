<script lang="ts">
	import { enhance } from '$app/forms';
	import { imageSrc } from '$lib/images';
	import type { SetlistEvent } from '$lib/types';
	import Icon from '$lib/components/Icon.svelte';
	import ImagePicker from '$lib/components/ImagePicker.svelte';
	import LogFields from '$lib/components/LogFields.svelte';
	import SetlistPicker from '$lib/components/SetlistPicker.svelte';
	import EpisodeSelect from '$lib/components/EpisodeSelect.svelte';
	import { logEpisodeLabel } from '$lib/episodes';

	let { data, form } = $props();
	const existing = $derived((data.log.external as { setlist?: SetlistEvent } | null)?.setlist ?? null);

	// svelte-ignore state_referenced_locally
	let chosen = $state<SetlistEvent | null>(existing);
	// svelte-ignore state_referenced_locally
	let logDate = $state<string>(data.log.date);
	// svelte-ignore state_referenced_locally
	let logLocation = $state<string>(data.log.location ?? '');
	let keepSetlist = $state(true);
	let busy = $state(false);

	// Shows linked to TMDB: which episode this log is for
	// svelte-ignore state_referenced_locally
	let epSeason = $state<number | null>(data.plays.length === 1 ? data.plays[0].season : null);
	// svelte-ignore state_referenced_locally
	let epNumber = $state<number | null>(data.plays.length === 1 ? data.plays[0].episode : null);
	let seasons = $state<{ number: number; aired: number; episodeCount: number }[]>([]);
	$effect(() => {
		data.seasons?.then((s) => (seasons = s));
	});
	const playsLabel = $derived(
		data.plays.length > 1
			? logEpisodeLabel({
					count: data.plays.length,
					first: data.plays[0],
					last: data.plays[data.plays.length - 1],
					title: null
				})
			: null
	);

	function onSetlist(e: SetlistEvent | null) {
		if (e) {
			logDate = e.date;
			logLocation = [e.venue, e.city].filter(Boolean).join(', ');
		}
	}
</script>

<svelte:head><title>Edit log · {data.item.title}</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<a
		href="/items/{data.item.id}"
		class="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
	>
		<Icon name="chevron-left" size={16} />
		{data.item.title}
	</a>
	<h1 class="mb-5 text-2xl font-semibold tracking-tight">Edit log</h1>

	<form
		method="POST"
		action="?/save"
		enctype="multipart/form-data"
		class="space-y-5"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		{#if form?.message}<p class="error-box">{form.message}</p>{/if}

		{#if data.canSetlist}
			{#if data.pick && !existing}
				<p class="rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
					Saved. setlist.fm lists more than one {data.item.title} show that day, so pick yours below to add its
					venue and setlist.
				</p>
			{/if}
			<!-- Attach, change or remove the setlist.fm show for this log -->
			<SetlistPicker
				itemId={data.item.id}
				initialDate={existing ? null : data.log.date}
				bind:selected={chosen}
				onpick={onSetlist}
			/>
			<input type="hidden" name="log_external" value={chosen ? JSON.stringify({ setlist: chosen }) : ''} />
		{:else if existing}
			<div class="card p-4 text-sm">
				<p class="font-medium">
					Setlist: {existing.venue}, {existing.city} ({existing.songs.length} songs)
				</p>
				<label class="mt-2 flex items-center gap-2">
					<input type="checkbox" bind:checked={keepSetlist} class="h-4 w-4 accent-[var(--accent)]" /> Keep setlist
				</label>
				<input
					type="hidden"
					name="log_external"
					value={keepSetlist ? JSON.stringify(data.log.external) : ''}
				/>
			</div>
		{/if}

		{#if data.tracked}
			{#if playsLabel}
				<p class="card p-4 text-sm">
					<span class="font-medium">{playsLabel}</span>
					<span class="text-muted">· marked together. Deleting this log un-watches them.</span>
				</p>
			{:else}
				<input type="hidden" name="log_episode_set" value="1" />
				<EpisodeSelect
					{seasons}
					episodesUrl={(s) => `/items/${data.item.id}/episodes?season=${s}`}
					bind:season={epSeason}
					bind:episode={epNumber}
					noneLabel="No particular episode"
					id="log-episode"
				/>
			{/if}
		{/if}

		<LogFields
			logFields={data.logFields}
			values={data.log}
			dateDefault={data.today}
			bind:date={logDate}
			bind:location={logLocation}
			locationLabel={data.canSetlist ? 'Venue' : 'Where'}
		/>

		<ImagePicker prefix="logimg_" label="Add photos" />

		<div class="flex gap-3">
			<button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
			<a class="btn" href="/items/{data.item.id}">Cancel</a>
		</div>
	</form>

	{#if data.images.length}
		<h2 class="section-title mt-8 mb-2">Photos on this log</h2>
		<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
			{#each data.images as img (img.id)}
				<div>
					<img src={imageSrc(img)} alt="" class="aspect-square w-full rounded-lg object-cover" />
					<form
						method="POST"
						action="?/deleteImage"
						use:enhance={({ cancel }) => {
							if (!confirm('Delete this photo?')) cancel();
						}}
					>
						<input type="hidden" name="imageId" value={img.id} />
						<button class="btn btn-ghost btn-sm mt-1 text-danger"
							><Icon name="trash" size={14} /> Delete</button
						>
					</form>
				</div>
			{/each}
		</div>
	{/if}

	<form
		method="POST"
		action="?/delete"
		class="mt-10 border-t border-border pt-6"
		use:enhance={({ cancel }) => {
			const unwatch = data.plays.length
				? ` ${data.plays.length === 1 ? 'Its episode' : 'Its episodes'} will be marked unwatched.`
				: '';
			if (!confirm(`Delete this log and its photos?${unwatch}`)) cancel();
		}}
	>
		<button class="btn btn-ghost btn-sm text-danger"><Icon name="trash" size={14} /> Delete log</button>
	</form>
</div>
