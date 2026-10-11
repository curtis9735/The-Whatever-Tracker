<script lang="ts">
	import type { SetlistEvent } from '$lib/types';

	let {
		itemId,
		selected = $bindable(null),
		onpick
	}: { itemId: number; selected?: SetlistEvent | null; onpick: (e: SetlistEvent | null) => void } = $props();

	let date = $state('');
	let year = $state('');
	let city = $state('');
	let busy = $state(false);
	let error = $state('');
	let events = $state<SetlistEvent[]>([]);
	let searched = $state(false);

	async function search() {
		busy = true;
		error = '';
		const sp = new URLSearchParams({ item: String(itemId) });
		if (date) sp.set('date', date);
		else if (year) sp.set('year', year);
		if (city) sp.set('city', city);
		try {
			const res = await fetch(`/api/setlists?${sp}`);
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Search failed');
			events = d.events;
			searched = true;
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
			</div>
			<button type="button" class="btn btn-sm" onclick={() => pick(null)}>Change</button>
		</div>
	{:else}
		<div class="grid gap-2 sm:grid-cols-3">
			<input class="input" type="date" bind:value={date} aria-label="Show date" />
			<input
				class="input"
				inputmode="numeric"
				maxlength="4"
				placeholder="or year"
				bind:value={year}
				aria-label="Year"
			/>
			<input class="input" placeholder="City (optional)" bind:value={city} aria-label="City" />
		</div>
		<button type="button" class="btn btn-sm mt-2" onclick={search} disabled={busy}>
			{busy ? 'Searching…' : 'Search setlists'}
		</button>
		{#if error}<p class="error-box mt-2">{error}</p>{/if}
		{#if searched && !events.length && !error}
			<p class="mt-2 text-sm text-muted">No setlists found. Try just the year, or leave the city out.</p>
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
