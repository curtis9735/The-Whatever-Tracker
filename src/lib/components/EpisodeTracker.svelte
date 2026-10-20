<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { episodeCode, seasonLabel, type TrackerView } from '$lib/episodes';
	import type { WatchingState } from '$lib/watching';
	import CheckInButton from './CheckInButton.svelte';
	import Icon from './Icon.svelte';
	import TrackerSeason from './TrackerSeason.svelte';
	import WatchCard from './WatchCard.svelte';

	interface StatusChange {
		key: string;
		label: string;
		group: string;
		from: string | null;
	}
	/** What the last change returned (see the item page's actions) */
	interface Outcome {
		checkedIn?: {
			watchId: number;
			logId: number | null;
			season: number;
			episode: number;
			title: string | null;
			duplicate: boolean;
			status: StatusChange | null;
		};
		unwatched?: {
			season: number;
			episode: number;
			removed: {
				id: number | null;
				title: string | null;
				watchedAt: string | null;
				createdAt: number | null;
			}[];
			kept: number;
		};
		marked?: { season: number | null; added: number; logId: number | null; status: StatusChange | null };
		unmarked?: { season: number; removed: number; kept: number };
		removedPlay?: boolean;
	}

	let {
		itemId,
		tracker,
		today,
		statusGroup,
		version,
		watching,
		onchanged,
		onlog
	}: {
		itemId: number;
		/** null while TMDB is being asked */
		tracker: TrackerView | null;
		today: string;
		/** The show's status group (planned, active, done, dropped) */
		statusGroup: string | undefined;
		version: number;
		/** The viewer's live check-in (Watching now), shown here when it's for this show */
		watching: WatchingState;
		/** After any change: open seasons fetch their episodes again */
		onchanged: () => void;
		/** Opens the full log form for an episode */
		onlog: (season: number, episode: number) => void;
	} = $props();

	let outcome = $state<Outcome | null>(null);
	let problem = $state<string | null>(null);
	let busy = $state(false);
	/** A live check-in (Check in) is being saved: Mark watched waits for it, and the other way round */
	let checkingIn = $state(false);
	let open = $state<Record<number, boolean>>({});
	let opened = false;

	// The season of the next episode starts open
	$effect(() => {
		if (opened || !tracker?.ok) return;
		opened = true;
		const s = tracker.next?.season;
		if (s !== undefined) open[s] = true;
	});

	/**
	 * One change at a time: a second tap while one is being saved is ignored, and so is one right
	 * after (by then the button may already be offering the following episode)
	 */
	let pending = false;
	let quietUntil = 0;
	const QUIET_MS = 1000;

	function submit(after?: () => void): SubmitFunction {
		return ({ cancel }) => {
			if (pending || checkingIn || Date.now() < quietUntil) {
				cancel();
				return;
			}
			pending = busy = true;
			problem = null;
			return async ({ result, update }) => {
				try {
					if (result.type === 'error') {
						// Stay on the page (not the error page) and show what's current
						problem = result.error?.message ?? 'That didn’t work. Try again.';
						await invalidateAll();
						return;
					}
					if (result.type === 'success') {
						const next = (result.data ?? null) as Outcome | null;
						if (!repeats(next)) outcome = next;
						after?.();
					} else if (result.type === 'failure') {
						problem = (result.data?.episodeError as string | undefined) ?? 'That didn’t work. Try again.';
					}
					// Taps stay blocked until the page shows the change
					await update({ reset: false });
				} finally {
					pending = busy = false;
					quietUntil = Date.now() + QUIET_MS;
					onchanged();
				}
			};
		};
	}

	/**
	 * The same change again (a second tap that got through): keep the message from the first,
	 * which has its Undo
	 */
	function repeats(next: Outcome | null) {
		const c = next?.checkedIn;
		if (c?.duplicate && outcome?.checkedIn?.watchId === c.watchId) return true;
		const u = next?.unwatched;
		const was = outcome?.unwatched;
		return !!u && !u.removed.length && !!was && was.season === u.season && was.episode === u.episode;
	}

	// Watching now: a live check-in for this show takes the next episode's place
	const liveHere = $derived(watching.live?.itemId === itemId ? watching.live : null);
	const finishedHere = $derived(watching.finished?.itemId === itemId ? watching.finished : null);
	function watchChanged() {
		outcome = null;
		onchanged();
	}
	// A check-in here that ends or changes some other way (on its own, or on another device): the open
	// seasons fetch their episodes again
	let watchKey: string | null = null;
	$effect(() => {
		const key = `${liveHere?.id ?? ''}:${finishedHere?.id ?? ''}`;
		const before = watchKey;
		watchKey = key;
		if (before !== null && before !== key) untrack(() => onchanged());
	});

	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

	function checkInText(c: NonNullable<Outcome['checkedIn']>) {
		const what = `${c.duplicate ? 'Already checked in' : 'Checked in'} ${episodeCode(c.season, c.episode)}${c.title ? ` · ${c.title}` : ''}.`;
		if (!c.status) return what;
		return `${what} ${c.status.group === 'done' ? 'That was the last episode: marked' : 'Now'} ${c.status.label}.`;
	}

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	const pct = $derived(
		tracker?.ok && tracker.aired ? Math.round((tracker.watched / tracker.aired) * 100) : 0
	);
	/** Seasons with plays that TMDB no longer lists */
	const gone = $derived(
		tracker?.ok
			? [...new Set(tracker.unmatched.map((u) => u.season))].filter(
					(n) => !tracker.seasons.some((s) => s.number === n)
				)
			: []
	);
</script>

{#snippet seasonRow(number: number, summary: string, done: boolean)}
	<li>
		<button
			type="button"
			class="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-2"
			aria-expanded={!!open[number]}
			onclick={() => (open[number] = !open[number])}
		>
			<span class="flex-1 font-medium">{seasonLabel(number)}</span>
			<span class="text-sm text-muted">{summary}</span>
			{#if done}<Icon name="check" size={16} class="text-accent" />{/if}
			<Icon name={open[number] ? 'chevron-up' : 'chevron-down'} size={16} class="text-muted" />
		</button>
		{#if open[number]}
			<div class="px-4">
				<TrackerSeason {itemId} season={number} {today} {version} {submit} {onlog} />
			</div>
		{/if}
	</li>
{/snippet}

<!-- Undo also takes back the status change, if any -->
{#snippet statusUndo(status: StatusChange | null)}
	{#if status}
		<input type="hidden" name="status_set" value={status.key} />
		<input type="hidden" name="status_was" value={status.from ?? ''} />
	{/if}
{/snippet}

<!-- The viewer's check-in for this show: running, paused, or just finished -->
{#snippet watchCard()}
	{#if liveHere || finishedHere}
		<WatchCard live={liveHere} finished={finishedHere} serverNow={watching.now} onchanged={watchChanged} />
	{/if}
{/snippet}

{#snippet outcomeLine()}
	{#if outcome?.checkedIn}
		{@const c = outcome.checkedIn}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="min-w-0 flex-1">
				<Icon name="check" size={14} class="inline text-accent" />
				{checkInText(c)}
			</span>
			{#if c.logId}<a class="text-accent hover:underline" href="/logs/{c.logId}/edit">Rate it</a>{/if}
			{#if !c.duplicate}
				<form method="POST" action="?/removePlay" use:enhance={submit(() => (outcome = null))}>
					<input type="hidden" name="watchId" value={c.watchId} />
					{@render statusUndo(c.status)}
					<button class="text-accent hover:underline">Undo</button>
				</form>
			{/if}
		</div>
	{:else if outcome?.unwatched}
		{@const u = outcome.unwatched}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="min-w-0 flex-1">
				{[
					u.removed.length ? `Unmarked ${episodeCode(u.season, u.episode)}.` : '',
					u.kept ? 'Check-ins with a log stay: open the episode to remove them.' : ''
				].join(' ')}
			</span>
			{#if u.removed.length}
				<form method="POST" action="?/restore" use:enhance={submit(() => (outcome = null))}>
					<input type="hidden" name="season" value={u.season} />
					<input type="hidden" name="episode" value={u.episode} />
					<input type="hidden" name="plays" value={JSON.stringify(u.removed)} />
					<button class="text-accent hover:underline">Undo</button>
				</form>
			{/if}
		</div>
	{:else if outcome?.marked}
		{@const m = outcome.marked}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="min-w-0 flex-1">
				{m.added ? `Marked ${plural(m.added, 'episode')} watched.` : 'Those were already watched.'}{m.status
					? ` Now ${m.status.label}.`
					: ''}
			</span>
			{#if m.logId}
				<a class="text-accent hover:underline" href="/logs/{m.logId}/edit">Rate it</a>
				<form method="POST" action="?/deleteLog" use:enhance={submit(() => (outcome = null))}>
					<input type="hidden" name="logId" value={m.logId} />
					{@render statusUndo(m.status)}
					<button class="text-accent hover:underline">Undo</button>
				</form>
			{/if}
		</div>
	{:else if outcome?.unmarked}
		{@const m = outcome.unmarked}
		<p>
			Unmarked {plural(m.removed, 'play')}.{m.kept
				? ` Kept ${plural(m.kept, 'episode')} with check-ins.`
				: ''}
		</p>
	{:else if outcome?.removedPlay}
		<p>Removed.</p>
	{/if}
{/snippet}

<section class="card mt-5 overflow-hidden" aria-label="Episodes">
	{#if !tracker}
		<div class="p-4">
			<h2 class="section-title">Episodes</h2>
			<p class="mt-2 text-sm text-muted">Loading episodes from TMDB…</p>
			<div class="mt-3 h-2 animate-pulse rounded-full bg-surface-2"></div>
			{#if liveHere || finishedHere}<div class="mt-4">{@render watchCard()}</div>{/if}
		</div>
	{:else if !tracker.ok}
		<div class="p-4">
			<h2 class="section-title">Episodes</h2>
			<p class="mt-2 text-sm text-muted">
				{tracker.error}, so the episode list isn't available right now. You've watched {tracker.watched}
				episode{tracker.watched === 1 ? '' : 's'}. You can still add a log for an episode below.
			</p>
			{#if liveHere || finishedHere}<div class="mt-4">{@render watchCard()}</div>{/if}
		</div>
		{#if tracker.seasons.length}
			<ul class="divide-y divide-border border-t border-border">
				{#each tracker.seasons as s (s.number)}
					{@render seasonRow(s.number, `${s.watched} watched`, false)}
				{/each}
			</ul>
		{/if}
	{:else}
		{@const t = tracker}
		<div class="space-y-4 p-4">
			<div>
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="section-title">Episodes</h2>
					<span class="text-sm text-muted">{t.watched} of {t.aired} watched</span>
				</div>
				<div
					class="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
					role="progressbar"
					aria-label="Episodes watched"
					aria-valuemin={0}
					aria-valuemax={t.aired}
					aria-valuenow={t.watched}
				>
					<div class="h-full rounded-full bg-accent transition-[width]" style="width: {pct}%"></div>
				</div>
			</div>

			{#if finishedHere && !liveHere}{@render watchCard()}{/if}

			{#if liveHere}
				{@render watchCard()}
			{:else if t.next}
				<div class="flex flex-wrap items-center gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-xs text-muted">
							{t.next.watchedBefore ? 'Next (watched before)' : 'Next episode'}
						</p>
						<p class="font-medium">
							{episodeCode(t.next.season, t.next.episode)}{t.next.title ? ` · ${t.next.title}` : ''}
						</p>
						{#if t.next.airDate}<p class="text-xs text-muted">Aired {pretty(t.next.airDate)}</p>{/if}
					</div>
					<!-- Check in: live, for the episode's length; Mark watched: right away -->
					<CheckInButton
						{itemId}
						pick={{ season: t.next.season, episode: t.next.episode }}
						minutes={t.next.runtime}
						disabled={busy}
						onchanged={watchChanged}
						onbusy={(b) => (checkingIn = b)}
					/>
					<form method="POST" action="?/checkIn" use:enhance={submit()}>
						<input type="hidden" name="season" value={t.next.season} />
						<input type="hidden" name="episode" value={t.next.episode} />
						<input type="hidden" name="when" value="today" />
						<button class="btn" disabled={busy || checkingIn}>
							<Icon name="check" size={16} />
							{busy ? 'Saving…' : 'Mark watched'}
						</button>
					</form>
				</div>
				<button
					type="button"
					class="-mt-2 text-sm text-accent hover:underline"
					onclick={() => t.next && onlog(t.next.season, t.next.episode)}
				>
					Other date, rating or notes
				</button>
			{:else}
				<p class="text-sm">
					{t.allWatched && t.ended
						? "You've watched every episode."
						: t.aired
							? 'Up to date.'
							: 'No episodes are out yet.'}
					{#if t.nextAiring}
						<span class="text-muted"
							>{` ${episodeCode(t.nextAiring.season, t.nextAiring.episode)} airs ${pretty(t.nextAiring.airDate)}.`}</span
						>
					{/if}
				</p>
			{/if}

			{#if outcome}
				<div class="rounded-xl bg-accent-soft px-3 py-2 text-sm" role="status">{@render outcomeLine()}</div>
			{/if}
			{#if problem}<p class="error-box" role="alert">{problem}</p>{/if}

			{#if statusGroup === 'done' && t.aired > t.watched}
				<form
					method="POST"
					action="?/markRemaining"
					class="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm"
					use:enhance={submit()}
				>
					<span class="min-w-0 flex-1">
						Also mark the {t.aired - t.watched} episode{t.aired - t.watched === 1 ? '' : 's'} you haven't checked
						in as watched?
					</span>
					<button class="btn btn-sm" disabled={busy}>Mark watched</button>
				</form>
			{/if}
			{#if t.unmatchedProgress}
				<p class="hint">
					Your saved progress ({t.unmatchedProgress}) isn't in TMDB's episode list, so nothing was marked.
					Tick the episodes you've seen below.
				</p>
			{/if}
		</div>

		<ul class="divide-y divide-border border-t border-border">
			{#each t.seasons as s (s.number)}
				{@render seasonRow(
					s.number,
					s.aired
						? `${s.watched}/${s.aired}${s.aired < s.episodeCount ? ` · ${s.episodeCount - s.aired} to come` : ''}`
						: s.airDate && s.airDate > today
							? `Airs ${pretty(s.airDate)}`
							: 'Not out yet',
					s.aired > 0 && s.watched === s.aired
				)}
			{/each}
			{#each gone as n (n)}
				{@render seasonRow(n, 'no longer on TMDB', false)}
			{/each}
		</ul>
	{/if}
</section>
