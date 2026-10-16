<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { episodeCode } from '$lib/episodes';
	import type { StatusDef } from '$lib/types';
	import EpisodeSelect from './EpisodeSelect.svelte';

	type Mode = 'none' | 'some' | 'all';
	interface Guide {
		ended: boolean;
		lastAired: { season: number; episode: number } | null;
		seasons: { number: number; aired: number; episodeCount: number }[];
	}

	let {
		tmdbId,
		statuses,
		status = $bindable()
	}: {
		/** The show picked from TMDB */
		tmdbId: string;
		statuses: StatusDef[];
		/** The Add form's status, kept in step with the progress picked here */
		status?: string;
	} = $props();

	let guide = $state<Guide | null>(null);
	let failed = $state(false);
	let mode = $state<Mode>('none');
	let season = $state<number | null>(null);
	let episode = $state<number | null>(null);

	let shownFor: string | undefined;
	$effect(() => {
		const id = tmdbId;
		// Another show: start over, giving back a status this picker set for the last one
		if (shownFor !== undefined && shownFor !== id) untrack(() => reset());
		shownFor = id;
		guide = null;
		failed = false;
		const c = new AbortController();
		fetch(`/api/tv/${id}`, { signal: c.signal })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
			.then((g: Guide) => (guide = g))
			.catch((e) => {
				if ((e as Error).name !== 'AbortError') failed = true;
			});
		return () => c.abort();
	});

	const regular = $derived(guide?.seasons.filter((s) => s.number > 0) ?? []);
	const airedTotal = $derived(regular.reduce((n, s) => n + s.aired, 0));
	const groupOf = (key: string | undefined) => statuses.find((s) => s.key === key)?.group;
	const firstOf = (group: string) => statuses.find((s) => s.group === group)?.key;

	// A finished status (Completed) means every episode so far was watched
	let seenStatus: string | undefined;
	$effect(() => {
		const s = status;
		if (s === seenStatus) return;
		seenStatus = s;
		if (groupOf(s) === 'done' && untrack(() => mode) === 'none') mode = 'all';
	});

	/** The status this picker set, and the one it replaced (put back if the choice is undone) */
	let autoStatus: string | undefined;
	let statusBefore: string | undefined;

	function reset() {
		if (autoStatus !== undefined && status === autoStatus) status = statusBefore;
		autoStatus = undefined;
		mode = 'none';
		season = null;
		episode = null;
	}

	// The match was cleared: the status goes back to what it was before this picker changed it
	onDestroy(() => {
		if (autoStatus !== undefined && status === autoStatus) status = statusBefore;
	});

	/** Saying what you've watched moves a planned show along */
	function choose(m: Mode) {
		mode = m;
		const ours = autoStatus !== undefined && status === autoStatus;
		if (m === 'none') {
			if (ours) status = statusBefore;
			autoStatus = undefined;
			return;
		}
		if (ours || !status || groupOf(status) === 'planned') {
			const next = m === 'all' && guide?.ended ? firstOf('done') : firstOf('active');
			if (next) {
				if (!ours) statusBefore = status;
				status = autoStatus = next;
			}
		}
		if (m === 'some' && season === null) season = regular.find((s) => s.aired > 0)?.number ?? null;
	}
</script>

<fieldset class="space-y-3 rounded-xl border border-border bg-surface-2/50 p-3">
	<legend class="px-1 text-sm font-medium">Your progress</legend>
	{#if failed}
		<p class="hint mt-0">
			TMDB's episode list couldn't be loaded. After saving, tick the episodes you've seen on the show's page.
		</p>
	{:else if !guide}
		<p class="hint mt-0">Loading episodes…</p>
	{:else}
		<div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Your progress">
			{#each [['none', "Haven't started"], ['some', 'Watched some'], ['all', 'Caught up']] as [value, label] (value)}
				<label
					class="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm {mode ===
					value
						? 'border-accent bg-accent-soft text-accent'
						: 'border-border'} {value === 'all' && !guide.lastAired ? 'opacity-50' : ''}"
				>
					<input
						type="radio"
						class="sr-only"
						name="progress_mode"
						{value}
						bind:group={mode}
						disabled={value === 'all' && !guide.lastAired}
						onchange={(e) => choose((e.currentTarget as HTMLInputElement).value as Mode)}
					/>
					{label}
				</label>
			{/each}
		</div>
		{#if mode === 'some'}
			<EpisodeSelect
				seasons={regular}
				episodesUrl={(n) => `/api/tv/${tmdbId}?season=${n}`}
				bind:season
				bind:episode
				airedOnly
				prefix="progress_"
				label="Last episode you watched"
				id="progress"
			/>
			<p class="hint mt-0">It and every episode before it are marked watched.</p>
		{:else if mode === 'all' && guide.lastAired}
			<input type="hidden" name="progress_season" value={guide.lastAired.season} />
			<input type="hidden" name="progress_episode" value={guide.lastAired.episode} />
			<p class="hint mt-0">
				All {airedTotal} episode{airedTotal === 1 ? '' : 's'} out so far (up to {episodeCode(
					guide.lastAired.season,
					guide.lastAired.episode
				)}) are marked watched.
			</p>
		{/if}
	{/if}
</fieldset>
