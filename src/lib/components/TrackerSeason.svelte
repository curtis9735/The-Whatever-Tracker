<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { episodeCode, seasonLabel } from '$lib/episodes';
	import Icon from './Icon.svelte';

	interface Play {
		id: number;
		logId: number | null;
		date: string | null;
		shared: number;
	}
	interface Episode {
		number: number;
		name: string | null;
		airDate: string | null;
		aired: boolean;
		plays: Play[];
	}
	interface View {
		ok: boolean;
		error?: string;
		episodes: Episode[];
		unlisted: { number: number; plays: Play[] }[];
	}

	let {
		itemId,
		season,
		today,
		version,
		submit,
		onlog
	}: {
		itemId: number;
		season: number;
		today: string;
		/** Bumped after every change, to fetch the season again */
		version: number;
		/** Form handler from the tracker: shows the outcome, refreshes the page; `after` runs on success */
		submit: (after?: () => void) => SubmitFunction;
		/** Opens the full log form for an episode (other date, rating, notes, photos) */
		onlog: (season: number, episode: number) => void;
	} = $props();

	let view = $state<View | null>(null);
	let failed = $state(false);
	/** The episode whose choices are open, and which choices */
	let open = $state<{ episode: number; mode: 'when' | 'plays'; otherDate: boolean } | null>(null);
	let seasonWhen = $state<false | 'choose' | 'date'>(false);

	$effect(() => {
		void version;
		load();
	});

	let latest = 0;
	async function load() {
		// Only the newest request counts (a change can land while an older fetch is still out)
		const mine = ++latest;
		try {
			const res = await fetch(`/items/${itemId}/episodes?season=${season}`);
			if (!res.ok) throw new Error();
			const fresh = await res.json();
			if (mine !== latest) return;
			view = fresh;
			failed = false;
		} catch {
			if (mine === latest) failed = true;
		}
	}

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	/** "Oct 3, 2026 · watched Oct 4, 2026 · 2×" */
	function episodeMeta(e: Episode) {
		const parts: string[] = [];
		if (e.airDate) parts.push(e.aired ? pretty(e.airDate) : `Airs ${pretty(e.airDate)}`);
		else if (!e.aired) parts.push('Not out yet');
		if (e.plays.length) {
			parts.push(e.plays[0].date ? `watched ${pretty(e.plays[0].date)}` : 'watched');
			if (e.plays.length > 1) parts.push(`${e.plays.length}×`);
		}
		return parts.join(' · ');
	}

	function toggle(episode: number, mode: 'when' | 'plays') {
		open = open?.episode === episode && open.mode === mode ? null : { episode, mode, otherDate: false };
	}

	const close = () => (open = null);
	const watchedCount = $derived(view?.episodes.filter((e) => e.plays.length).length ?? 0);
	/** Plays marked watched without saying when (not check-ins, not imported dates) */
	const undated = (p: Play) => !p.logId && !p.date;
	const anyUndated = $derived(
		!!view?.episodes.some((e) => e.plays.some(undated)) || !!view?.unlisted.some((u) => u.plays.some(undated))
	);

	function confirmRemove(p: Play): SubmitFunction {
		return (input) => {
			if (
				p.logId &&
				!p.shared &&
				!confirm(
					`This also deletes the log${p.date ? ` from ${pretty(p.date)}` : ''}, with its rating, notes and photos.`
				)
			) {
				input.cancel();
				return;
			}
			return submit()(input);
		};
	}
</script>

{#snippet playList(episode: number, plays: Play[])}
	<ul class="space-y-1">
		{#each plays as p (p.id)}
			<li class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span class="min-w-0 flex-1">
					{p.date ? pretty(p.date) : 'Date not known'}{#if p.shared}<span class="text-muted"
							>{` · with ${p.shared} other episode${p.shared === 1 ? '' : 's'}`}</span
						>{/if}
				</span>
				{#if p.logId}<a class="text-accent hover:underline" href="/logs/{p.logId}/edit">Open log</a>{/if}
				<form method="POST" action="?/removePlay" use:enhance={confirmRemove(p)}>
					<input type="hidden" name="watchId" value={p.id} />
					<button
						class="text-danger hover:underline"
						aria-label="Remove this play of {episodeCode(season, episode)}">Remove</button
					>
				</form>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet whenChoices(episode: number, airDate: string | null)}
	<div class="flex flex-wrap items-center gap-2">
		<form method="POST" action="?/checkIn" use:enhance={submit(close)}>
			<input type="hidden" name="season" value={season} />
			<input type="hidden" name="episode" value={episode} />
			<input type="hidden" name="when" value="today" />
			<button class="btn btn-primary btn-sm">Today</button>
		</form>
		{#if airDate && airDate < today}
			<form method="POST" action="?/checkIn" use:enhance={submit(close)}>
				<input type="hidden" name="season" value={season} />
				<input type="hidden" name="episode" value={episode} />
				<input type="hidden" name="when" value="date" />
				<input type="hidden" name="date" value={airDate} />
				<button class="btn btn-sm">When it aired</button>
			</form>
		{/if}
		<button type="button" class="btn btn-sm" onclick={() => open && (open.otherDate = !open.otherDate)}
			>Other date…</button
		>
		<form method="POST" action="?/checkIn" use:enhance={submit(close)}>
			<input type="hidden" name="season" value={season} />
			<input type="hidden" name="episode" value={episode} />
			<input type="hidden" name="when" value="unknown" />
			<button class="btn btn-sm">Don't remember</button>
		</form>
		<button type="button" class="btn btn-ghost btn-sm" onclick={() => onlog(season, episode)}
			>Rate & notes</button
		>
	</div>
	{#if open?.otherDate}
		<form method="POST" action="?/checkIn" class="mt-2 flex items-end gap-2" use:enhance={submit(close)}>
			<input type="hidden" name="season" value={season} />
			<input type="hidden" name="episode" value={episode} />
			<input type="hidden" name="when" value="date" />
			<input
				class="input w-auto"
				type="date"
				name="date"
				required
				max={today}
				value={today}
				aria-label="Date watched"
			/>
			<button class="btn btn-primary btn-sm">Save</button>
		</form>
	{/if}
{/snippet}

<div class="pb-2">
	{#if !view}
		<p class="py-3 text-sm text-muted">{failed ? 'Could not load this season.' : 'Loading episodes…'}</p>
	{:else}
		{#if !view.ok}<p class="mb-2 text-sm text-muted">
				{view.error} Showing the episodes you've watched.
			</p>{/if}
		<ul class="divide-y divide-border">
			{#each view.episodes as e (e.number)}
				{@const watched = e.plays.length > 0}
				{@const quickUnwatch = e.plays.length === 1 && !e.plays[0].logId && !e.plays[0].date}
				<li class="py-1.5">
					<div class="flex items-center gap-3">
						{#if quickUnwatch}
							<!-- Marked without a date: one tap takes it back (with Undo) -->
							<form method="POST" action="?/unwatch" use:enhance={submit(close)}>
								<input type="hidden" name="season" value={season} />
								<input type="hidden" name="episode" value={e.number} />
								<button
									class="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-accent-fg"
									aria-label="Watched {episodeCode(season, e.number)}: tap to unmark"
									aria-pressed="true"
								>
									<Icon name="check" size={20} />
								</button>
							</form>
						{:else}
							<button
								type="button"
								class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 {watched
									? 'border-accent bg-accent text-accent-fg'
									: e.aired
										? 'border-border text-transparent hover:text-muted'
										: 'border-dashed border-border text-transparent'}"
								aria-label={watched
									? `Watched ${episodeCode(season, e.number)}: see plays`
									: `Check in ${episodeCode(season, e.number)}`}
								aria-pressed={watched}
								aria-expanded={open?.episode === e.number}
								onclick={() => toggle(e.number, watched ? 'plays' : 'when')}
							>
								<Icon name="check" size={20} />
							</button>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm">
								<span class="font-medium">E{e.number}</span>{e.name ? ` · ${e.name}` : ''}
							</p>
							<p class="truncate text-xs text-muted">{episodeMeta(e)}</p>
						</div>
					</div>
					{#if open?.episode === e.number}
						<div class="mt-2 mb-1 space-y-3 rounded-xl bg-surface-2 p-3 text-sm sm:ml-14">
							{#if open.mode === 'when'}
								{#if !e.aired}<p class="text-muted">
										This one isn't out yet{e.airDate ? `: it airs ${pretty(e.airDate)}` : ''}.
									</p>{/if}
								<p class="font-medium">When did you watch {episodeCode(season, e.number)}?</p>
								{@render whenChoices(e.number, e.airDate)}
							{:else}
								{@render playList(e.number, e.plays)}
								<div class="flex flex-wrap gap-2">
									<button type="button" class="btn btn-sm" onclick={() => open && (open.mode = 'when')}
										>Watch again</button
									>
									<button type="button" class="btn btn-ghost btn-sm" onclick={close}>Close</button>
								</div>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
			{#each view.unlisted as u (u.number)}
				<li class="py-2 text-sm">
					<p>
						<span class="font-medium">E{u.number}</span>
						<span class="text-muted">· {view.ok ? 'no longer in TMDB’s episode list' : 'watched'}</span>
					</p>
					<div class="mt-1 sm:ml-14">{@render playList(u.number, u.plays)}</div>
				</li>
			{/each}
		</ul>

		{#if view.ok && view.episodes.some((e) => e.aired)}
			<div class="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3">
				{#if watchedCount < view.episodes.filter((e) => e.aired).length}
					<button
						type="button"
						class="btn btn-sm"
						onclick={() => (seasonWhen = seasonWhen ? false : 'choose')}
					>
						<Icon name="check" size={14} /> Mark {seasonLabel(season).toLowerCase()} watched
					</button>
				{/if}
				{#if anyUndated}
					<form
						method="POST"
						action="?/unmarkSeason"
						use:enhance={(input) => {
							if (
								!confirm(
									`Unmark the episodes of ${seasonLabel(season)} that were marked without a date? Check-ins with a log and imported dates stay.`
								)
							) {
								input.cancel();
								return;
							}
							return submit()(input);
						}}
					>
						<input type="hidden" name="season" value={season} />
						<button class="btn btn-ghost btn-sm">Unmark season</button>
					</form>
				{/if}
			</div>
			{#if seasonWhen}
				<div class="mt-2 space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
					<p class="font-medium">
						When did you watch it? Episodes you've already checked in are left as they are.
					</p>
					<div class="flex flex-wrap items-center gap-2">
						<form method="POST" action="?/markSeason" use:enhance={submit(() => (seasonWhen = false))}>
							<input type="hidden" name="season" value={season} />
							<input type="hidden" name="when" value="today" />
							<button class="btn btn-primary btn-sm">Today</button>
						</form>
						<button type="button" class="btn btn-sm" onclick={() => (seasonWhen = 'date')}>Other date…</button
						>
						<form method="POST" action="?/markSeason" use:enhance={submit(() => (seasonWhen = false))}>
							<input type="hidden" name="season" value={season} />
							<input type="hidden" name="when" value="unknown" />
							<button class="btn btn-sm">Don't remember</button>
						</form>
						<button type="button" class="btn btn-ghost btn-sm" onclick={() => (seasonWhen = false)}
							>Cancel</button
						>
					</div>
					{#if seasonWhen === 'date'}
						<form
							method="POST"
							action="?/markSeason"
							class="flex items-end gap-2"
							use:enhance={submit(() => (seasonWhen = false))}
						>
							<input type="hidden" name="season" value={season} />
							<input type="hidden" name="when" value="date" />
							<input
								class="input w-auto"
								type="date"
								name="date"
								required
								max={today}
								value={today}
								aria-label="Date watched"
							/>
							<button class="btn btn-primary btn-sm">Save</button>
						</form>
					{/if}
					<p class="hint">With a date, the season is one entry in the history and Journal.</p>
				</div>
			{/if}
		{/if}
	{/if}
</div>
