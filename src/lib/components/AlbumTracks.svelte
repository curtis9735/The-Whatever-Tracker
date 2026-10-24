<script lang="ts">
	// The viewer's own plays of an album, track by track: the tracklist in order (unplayed ones muted),
	// then what else they played. Lists longer than COLLAPSED are folded behind "Show all".
	type Row = { name: string; plays: number; last: string | null };
	let { tracks }: { tracks: { hasTracklist: boolean; tracks: Row[]; also: Row[] } } = $props();

	const COLLAPSED = 15;

	type Line = Row & { num: number | null; heading: boolean };
	const lines = $derived.by<Line[]>(() => {
		const listed = tracks.tracks.map((t, i) => ({ ...t, num: i + 1, heading: false }));
		const also = tracks.also.map((t, i) => ({
			...t,
			num: null,
			// "Also played" labels the extras that follow a tracklist; without one they are the whole list
			heading: tracks.hasTracklist && i === 0
		}));
		return [...listed, ...also];
	});
	let all = $state(false);
	const long = $derived(lines.length > COLLAPSED);
	const shown = $derived(long && !all ? lines.slice(0, COLLAPSED) : lines);

	/** "Oct 20", with the year when it isn't this one */
	function short(d: string) {
		const date = new Date(`${d}T00:00:00`);
		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
		});
	}
</script>

<section class="card mt-5 p-4" aria-labelledby="album-tracks">
	<h2 id="album-tracks" class="section-title mb-2">Tracks</h2>
	<ol class="divide-y divide-border text-sm">
		{#each shown as t, i (i)}
			{#if t.heading}
				<li class="list-none pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
					Also played
				</li>
			{/if}
			<li class="flex items-baseline gap-2 py-1.5 {t.plays ? '' : 'text-muted'}">
				<span class="w-6 shrink-0 text-right text-muted tabular-nums"
					>{t.num === null ? '' : t.num + '.'}</span
				>
				<span class="min-w-0 flex-1 break-words">{t.name}</span>
				<span class="shrink-0 text-right text-xs {t.plays ? '' : 'italic'}">
					{#if t.plays}
						<span class="font-medium">{t.plays + (t.plays === 1 ? ' play' : ' plays')}</span>
						{#if t.last}<span class="block text-muted">{'last played ' + short(t.last)}</span>{/if}
					{:else}
						{'not played'}
					{/if}
				</span>
			</li>
		{/each}
	</ol>
	{#if long}
		<button type="button" class="btn btn-sm mt-3" onclick={() => (all = !all)}>
			{all ? 'Show fewer' : `Show all ${lines.length} tracks`}
		</button>
	{/if}
</section>
