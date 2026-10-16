<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ImagePicker from '$lib/components/ImagePicker.svelte';
	import ItemForm from '$lib/components/ItemForm.svelte';
	import LogFields from '$lib/components/LogFields.svelte';
	import MetadataMatch from '$lib/components/MetadataMatch.svelte';
	import ShowProgress from '$lib/components/ShowProgress.svelte';
	import { PROGRESS_KEYS } from '$lib/episodes';
	import { KIND_BY_KEY, PROVIDER_LABELS, SETLIST_SOURCE } from '$lib/kinds';
	import { isFinished } from '$lib/status';
	import type { SearchResult } from '$lib/types';

	let { data, form } = $props();
	const cat = $derived(data.chosen.category);
	let busy = $state(false);

	// Picking a finished status (Completed, Tasted, Seen…) asks "When" instead of a separate log step
	let status = $state<string | undefined>(undefined);
	const finished = $derived(isFinished(cat.statuses, status));
	const setlistShow = $derived(data.setlistReady && cat.providerKinds.includes(SETLIST_SOURCE));

	// Look the name up on this list's metadata sources (e.g. TMDB for Movies) as it's typed
	// svelte-ignore state_referenced_locally
	let title = $state(data.defaults.title);
	let match = $state<SearchResult | null>(null);
	const matchKinds = $derived(data.searchKinds.filter((k) => cat.providerKinds.includes(k)));
	const missingSources = $derived(
		[
			...new Set(
				cat.providerKinds
					.filter((k) => KIND_BY_KEY.has(k) && !data.searchKinds.includes(k))
					.map((k) => PROVIDER_LABELS[k.split(':')[0]])
			)
		].join(' and ')
	);

	// A show from TMDB: progress is picked from its real episodes instead of typed in
	const tvMatch = $derived(match?.provider === 'tmdb' && match.kind === 'tv' ? match : null);
	const formFields = $derived(
		tvMatch ? data.chosen.itemFields.filter((f) => !PROGRESS_KEYS.includes(f.key)) : data.chosen.itemFields
	);

	function onMatch(r: SearchResult | null) {
		if (r) title = r.title;
	}

	function switchCategory(slug: string) {
		match = null;
		status = undefined; // the other list has its own statuses; ItemForm picks its first

		const sp = new URLSearchParams(page.url.searchParams);
		sp.set('category', slug);
		// Keep what was typed so far when the form re-renders for the other list
		for (const name of ['title', 'subtitle', 'barcode'] as const) {
			const el = document.getElementById(name) as HTMLInputElement | null;
			if (el?.value) sp.set(name, el.value);
		}
		goto(`?${sp}`, { replaceState: true, keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>New {cat.name} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<h1 class="mb-5 text-2xl font-semibold tracking-tight">Add to {cat.icon} {cat.name}</h1>

	<div class="mb-5">
		<label class="label" for="category-switch">List</label>
		<select
			class="input"
			id="category-switch"
			value={cat.slug}
			onchange={(e) => switchCategory((e.currentTarget as HTMLSelectElement).value)}
		>
			{#each data.categories as c (c.id)}<option value={c.slug}>{c.icon} {c.name}</option>{/each}
		</select>
		{#if missingSources && !matchKinds.length}
			<p class="hint">
				Connect {missingSources} under
				<a class="text-accent underline" href="/settings#integrations">Me → Integrations</a> to fill in posters
				and details automatically.
			</p>
		{/if}
	</div>

	<form
		method="POST"
		enctype="multipart/form-data"
		class="space-y-6"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<input type="hidden" name="categoryId" value={cat.id} />
		{#if form?.message}
			<p class="error-box" role="alert">
				{form.message}
				{#if 'existingId' in form && form.existingId}
					<a class="font-medium underline" href="/items/{form.existingId}">Open it</a>
				{/if}
			</p>
		{/if}

		{#key cat.id}
			<ItemForm
				category={cat}
				itemFields={formFields}
				allTags={data.allTags}
				bind:title
				bind:status
				values={{
					title: data.defaults.title,
					subtitle: data.defaults.subtitle,
					barcode: data.defaults.barcode,
					status: cat.statuses[0]?.key
				}}
			>
				{#snippet afterTitle()}
					{#if matchKinds.length}
						<MetadataMatch kinds={matchKinds} query={title} bind:selected={match} onselect={onMatch} />
					{/if}
				{/snippet}
				{#snippet afterStatus()}
					{#if tvMatch}
						<ShowProgress tmdbId={tvMatch.id} statuses={cat.statuses} bind:status />
					{/if}
					{#if finished}
						<!-- A finished status means it already happened: record when as the first log -->
						<div class="space-y-3 rounded-xl border border-border bg-surface-2/50 p-3">
							<div class="grid gap-3 sm:grid-cols-2 sm:items-end">
								<div>
									<label class="label" for="log_date">When</label>
									<input class="input" id="log_date" name="log_date" type="date" value={data.today} />
								</div>
								<p class="hint sm:mb-3">
									Saved as the first entry in its history, with your rating below. Clear the date to skip.
								</p>
							</div>
							{#if setlistShow}
								<p class="hint mt-0">The show's venue and setlist are pulled from setlist.fm for that day.</p>
							{/if}
							<details>
								<summary class="cursor-pointer text-sm font-medium text-accent">
									More about this time (where, notes, photos)
								</summary>
								<div class="mt-3 space-y-4">
									<LogFields
										logFields={data.chosen.logFields}
										dateDefault={data.today}
										showDate={false}
										showRating={false}
										locationLabel={setlistShow ? 'Venue' : 'Where'}
									/>
									<ImagePicker prefix="logimg_" label="Photos from this time" />
								</div>
							</details>
						</div>
					{/if}
				{/snippet}
			</ItemForm>
		{/key}

		<div class="card p-4">
			<ImagePicker prefix="img_" label="Photos" defaultUrl={data.defaults.image} />
		</div>

		<div class="sticky bottom-20 flex gap-3 md:bottom-4">
			<button class="btn btn-primary flex-1 shadow-lg sm:flex-none" disabled={busy}>
				{busy ? 'Saving…' : 'Save'}
			</button>
			<a class="btn shadow-lg" href="/c/{cat.slug}">Cancel</a>
		</div>
	</form>
</div>
