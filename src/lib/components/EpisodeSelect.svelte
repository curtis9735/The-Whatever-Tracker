<script lang="ts">
	import { seasonLabel } from '$lib/episodes';

	interface Episode {
		number: number;
		name: string | null;
		airDate: string | null;
		aired: boolean;
		plays?: unknown[];
	}

	let {
		seasons,
		episodesUrl,
		season = $bindable(null),
		episode = $bindable(null),
		airedOnly = false,
		noneLabel = null,
		prefix = 'log_',
		label = 'Episode',
		id = 'episode-pick'
	}: {
		/** The show's seasons from TMDB; empty when TMDB couldn't be reached (numbers are typed instead) */
		seasons: { number: number; aired: number; episodeCount: number }[];
		/** Where a season's episodes are fetched from ({ episodes: Episode[] }) */
		episodesUrl: (season: number) => string;
		season?: number | null;
		episode?: number | null;
		/** Only episodes that are out (the Add form's "last episode you watched") */
		airedOnly?: boolean;
		/** Offers "no episode" under this label (logs that aren't for one episode) */
		noneLabel?: string | null;
		/** The inputs are posted as `<prefix>season` and `<prefix>episode` */
		prefix?: string;
		label?: string;
		id?: string;
	} = $props();

	const choices = $derived(seasons.filter((s) => (airedOnly ? s.aired > 0 : s.episodeCount > 0)));
	// What it started with (an existing log's episode) stays selectable even if TMDB no longer lists it
	// svelte-ignore state_referenced_locally
	const initial = { season, episode };
	const initialSeasonGone = $derived(
		initial.season !== null &&
			initial.season !== undefined &&
			!choices.some((c) => c.number === initial.season)
	);
	let episodes = $state<Episode[]>([]);
	const shown = $derived(airedOnly ? episodes.filter((e) => e.aired) : episodes);
	let phase = $state<'idle' | 'loading' | 'error'>('idle');
	const initialEpisodeGone = $derived(
		season === initial.season &&
			initial.episode !== null &&
			initial.episode !== undefined &&
			phase === 'idle' &&
			!shown.some((e) => e.number === initial.episode)
	);
	let controller: AbortController | null = null;
	let loadedFor: number | null = null;

	// The season's episode list, fetched whenever another season is picked
	$effect(() => {
		const s = season;
		if (s === null || s === undefined || !seasons.length) {
			episodes = [];
			return;
		}
		load(s);
	});

	async function load(s: number) {
		controller?.abort();
		const c = (controller = new AbortController());
		phase = 'loading';
		if (s !== loadedFor) episodes = [];
		try {
			const res = await fetch(episodesUrl(s), { signal: c.signal });
			const d = await res.json();
			if (!res.ok || !Array.isArray(d.episodes) || (d.ok === false && !d.episodes.length)) throw new Error();
			episodes = d.episodes;
			loadedFor = s;
			phase = 'idle';
			const usable = airedOnly ? episodes.filter((e) => e.aired) : episodes;
			const keep = s === initial.season && episode === initial.episode;
			if (!keep && !usable.some((e) => e.number === episode)) episode = usable[0]?.number ?? null;
		} catch (e) {
			if ((e as Error).name !== 'AbortError') phase = 'error';
		}
	}

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	function onSeason(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		episode = null;
		season = v === '' ? null : Number(v);
	}
</script>

<div class="space-y-2">
	{#if choices.length}
		<div class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
			<div>
				<label class="label" for="{id}-season">Season</label>
				<select class="input" id="{id}-season" value={season ?? ''} onchange={onSeason}>
					{#if noneLabel !== null}<option value="">{noneLabel}</option>{/if}
					{#if initialSeasonGone}
						<option value={initial.season}>{seasonLabel(initial.season!)} · not on TMDB any more</option>
					{/if}
					{#each choices as s (s.number)}
						<option value={s.number}
							>{seasonLabel(s.number)} · {airedOnly || s.aired === s.episodeCount
								? `${s.aired} ep${s.aired === 1 ? '' : 's'}`
								: `${s.aired} of ${s.episodeCount} out`}</option
						>
					{/each}
				</select>
			</div>
			<div>
				<label class="label" for="{id}-episode">{label}</label>
				{#if season === null || season === undefined}
					<select class="input" id="{id}-episode" disabled><option>—</option></select>
				{:else if phase === 'error'}
					<input
						class="input"
						id="{id}-episode"
						type="number"
						min="1"
						max="9999"
						inputmode="numeric"
						placeholder="Number"
						bind:value={episode}
					/>
				{:else}
					<select class="input" id="{id}-episode" bind:value={episode} disabled={phase === 'loading'}>
						{#if phase === 'loading' && !episodes.length}<option value={episode}>Loading…</option>{/if}
						{#if initialEpisodeGone}
							<option value={initial.episode}>E{initial.episode} · not in TMDB's list any more</option>
						{/if}
						{#each shown as e (e.number)}
							<option value={e.number}
								>E{e.number}{e.name ? ` · ${e.name}` : ''}{e.aired
									? ''
									: e.airDate
										? ` · airs ${pretty(e.airDate)}`
										: ' · not out yet'}{e.plays?.length ? ' ✓' : ''}</option
							>
						{/each}
					</select>
				{/if}
			</div>
		</div>
		{#if phase === 'error'}
			<p class="hint">This season's episodes couldn't be loaded from TMDB, so type the episode number.</p>
		{/if}
	{:else}
		<!-- No episode list (TMDB unreachable): numbers are checked when TMDB is back -->
		<div class="grid grid-cols-2 gap-2">
			<div>
				<label class="label" for="{id}-season">Season</label>
				<input
					class="input"
					id="{id}-season"
					type="number"
					min="0"
					max="9999"
					inputmode="numeric"
					bind:value={season}
				/>
			</div>
			<div>
				<label class="label" for="{id}-episode">{label}</label>
				<input
					class="input"
					id="{id}-episode"
					type="number"
					min="1"
					max="9999"
					inputmode="numeric"
					bind:value={episode}
				/>
			</div>
		</div>
	{/if}
	{#if season !== null && season !== undefined && episode !== null && episode !== undefined && String(episode) !== ''}
		<input type="hidden" name="{prefix}season" value={season} />
		<input type="hidden" name="{prefix}episode" value={episode} />
	{/if}
</div>
