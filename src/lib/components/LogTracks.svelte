<script lang="ts">
	// "N tracks · last.fm" on an imported log. Opening it loads that day's tracks (once), so a page
	// with hundreds of logs doesn't carry every day's list.
	let { itemId, date, plays }: { itemId: number; date: string; plays: number } = $props();

	let tracks = $state<{ name: string; count: number }[] | null>(null);
	let failed = $state(false);
	let loading = $state(false);

	async function toggle(e: Event) {
		if (!(e.currentTarget as HTMLDetailsElement).open || tracks || loading) return;
		loading = true;
		failed = false;
		try {
			const res = await fetch(`/items/${itemId}/tracks?date=${encodeURIComponent(date)}`);
			if (!res.ok) throw new Error(String(res.status));
			tracks = (await res.json()).tracks;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}
</script>

<details class="text-sm" ontoggle={toggle}>
	<summary class="cursor-pointer text-muted">
		<span aria-hidden="true">🎧</span>
		{plays + (plays === 1 ? ' track' : ' tracks') + ' · last.fm'}
	</summary>
	<div class="mt-2 rounded-lg bg-surface-2 p-3">
		{#if loading}
			<p class="text-muted">Loading…</p>
		{:else if failed}
			<p class="text-muted">
				{"Couldn't load the tracks."}
			</p>
		{:else if tracks && !tracks.length}
			<p class="text-muted">No track names for this day.</p>
		{:else if tracks}
			<ul class="space-y-0.5">
				{#each tracks as t, i (i)}
					<li class="break-words">{t.count > 1 ? `${t.name} ×${t.count}` : t.name}</li>
				{/each}
			</ul>
		{/if}
	</div>
</details>
