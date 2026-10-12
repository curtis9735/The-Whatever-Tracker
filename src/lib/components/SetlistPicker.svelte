<script lang="ts">
	import { onMount } from 'svelte';
	import type { SetlistEvent } from '$lib/types';

	let {
		itemId,
		initialDate = null,
		selected = $bindable(null),
		onpick
	}: {
		itemId: number;
		/** Search this date as soon as the picker appears */
		initialDate?: string | null;
		selected?: SetlistEvent | null;
		onpick: (e: SetlistEvent | null) => void;
	} = $props();

	let date = $state('');
	let year = $state('');
	let city = $state('');
	let venue = $state('');
	let busy = $state(false);
	let error = $state('');
	let events = $state<SetlistEvent[]>([]);
	let searched = $state<'' | 'date' | 'other'>('');

	onMount(() => {
		if (initialDate) {
			date = initialDate;
			search();
		}
	});

	async function search() {
		busy = true;
		error = '';
		const sp = new URLSearchParams({ item: String(itemId) });
		if (date) sp.set('date', date);
		else if (year) sp.set('year', year);
		if (city.trim()) sp.set('city', city.trim());
		if (venue.trim()) sp.set('venue', venue.trim());
		try {
			const res = await fetch(`/api/setlists?${sp}`);
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Search failed');
			events = d.events;
			searched = date ? 'date' : 'other';
			// One show on that exact day: that's the one
			if (date && events.length === 1) pick(events[0]);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	function pick(e: SetlistEvent | null) {
		selected = e;
		onpick(e);
	}

	/** Enter searches instead of submitting the surrounding log form */
	function onEnter(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			search();
		}
	}

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}
</script>

<div class="rounded-xl border border-border bg-surface-2/50 p-3">
	<p class="mb-2 text-sm font-medium">Find the show on setlist.fm</p>
	{#if selected}
		<div class="flex items-start justify-between gap-3">
			<div class="text-sm">
				<p class="font-medium">{selected.venue}</p>
				<p class="text-muted">
					{selected.city}{selected.country ? `, ${selected.country}` : ''} · {pretty(selected.date)}
				</p>
				<p class="text-xs text-muted">
					{selected.songs.length} songs{selected.tour ? ` · ${selected.tour}` : ''}
				</p>
				<p class="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
					Date and venue filled in below. The setlist is saved with this log.
				</p>
			</div>
			<button type="button" class="btn btn-sm" onclick={() => pick(null)}>Change</button>
		</div>
	{:else}
		<div class="grid gap-2 sm:grid-cols-2">
			<input class="input" type="date" bind:value={date} onkeydown={onEnter} aria-label="Show date" />
			<input
				class="input"
				inputmode="numeric"
				maxlength="4"
				placeholder="or just the year"
				bind:value={year}
				onkeydown={onEnter}
				aria-label="Year"
			/>
			<input
				class="input"
				placeholder="City (optional)"
				bind:value={city}
				onkeydown={onEnter}
				aria-label="City"
			/>
			<input
				class="input"
				placeholder="Venue (optional)"
				bind:value={venue}
				onkeydown={onEnter}
				aria-label="Venue"
			/>
		</div>
		<button type="button" class="btn btn-sm mt-2" onclick={search} disabled={busy}>
			{busy ? 'Searching…' : 'Search setlists'}
		</button>
		{#if error}<p class="error-box mt-2">{error}</p>{/if}
		{#if searched && !events.length && !error}
			<p class="mt-2 text-sm text-muted">
				{#if searched === 'date'}
					setlist.fm doesn't have a show on that day yet. Fans usually add setlists within a few days of a
					concert, so try again later, or search by year instead.
				{:else}
					No setlists found. Try just the year, or leave the city and venue out.
				{/if}
			</p>
		{/if}
		{#if events.length}
			<ul
				class="mt-3 max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface"
			>
				{#each events as e (e.id)}
					<li>
						<button
							type="button"
							class="w-full p-3 text-left text-sm hover:bg-surface-2"
							onclick={() => pick(e)}
						>
							<span class="font-medium">{pretty(e.date)}</span> · {e.venue}
							<span class="block text-xs text-muted">
								{e.city}{e.country ? `, ${e.country}` : ''} · {e.songs.length} songs{e.tour
									? ` · ${e.tour}`
									: ''}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>
