<script lang="ts">
	import { episodeCode, logEpisodeLabel, type LogEpisodes } from '$lib/episodes';
	import { formatFieldValue } from '$lib/fields';
	import type { FieldDef, StatusDef } from '$lib/types';
	import { formatLength, timeLeft } from '$lib/watching';
	import { clockNow, keepTicking } from '$lib/watching-ui.svelte';
	import Icon from './Icon.svelte';
	import Rating from './Rating.svelte';

	/** Someone else's progress on an item of a shared list (see householdProgress in the items service) */
	interface Person {
		userId: number;
		name: string;
		status: string | null;
		rating: number | null;
		favorite: boolean;
		notes: string | null;
		lastLoggedAt: string | null;
		/** Their last.fm plays of it (0 when none) */
		plays: number;
		logs: {
			id: number;
			date: string;
			rating: number | null;
			notes: string | null;
			location: string | null;
			custom: Record<string, unknown>;
			episodes: LogEpisodes | null;
			/** An imported last.fm log */
			external: { lastfm: { plays: number } } | null;
		}[];
		logCount: number;
		episodesWatched: number;
		furthest: { season: number; episode: number } | null;
		/** Their live check-in on it, if one is running or paused */
		watching: {
			season: number | null;
			episode: number | null;
			episodeTitle: string | null;
			endsAt: number;
			pausedAt: number | null;
			durationMs: number;
		} | null;
	}

	let {
		people,
		statuses,
		logFields,
		tracked = false,
		serverNow
	}: {
		people: Person[];
		statuses: StatusDef[];
		logFields: FieldDef[];
		/** A show linked to TMDB: say how far each person has got */
		tracked?: boolean;
		/** The server's time when the page was loaded (for "20 min left") */
		serverNow: number;
	} = $props();

	const now = $derived(clockNow(serverNow));
	/** Paused, or with time left: once their time is up it's being marked watched, so it isn't "now" */
	const stillWatching = (w: Person['watching']) => !!w && (w.pausedAt !== null || w.endsAt > now);
	// Someone watching it right now: their countdown ticks along, until it runs out
	keepTicking(() =>
		people.some((p) => p.watching && p.watching.pausedAt === null && p.watching.endsAt > now)
	);

	/** "Watching now · S2 E5 · 20 min left", or "… · Paused" */
	function watchingNow(w: NonNullable<Person['watching']>) {
		const code = w.season !== null && w.episode !== null ? episodeCode(w.season, w.episode) : null;
		const when = w.pausedAt !== null ? 'Paused' : `${formatLength(timeLeft(w, now))} left`;
		return ['Watching now', code, when].filter(Boolean).join(' · ');
	}

	const statusLabel = (key: string | null) =>
		key ? (statuses.find((s) => s.key === key)?.label ?? key) : null;

	function pretty(d: string) {
		return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	function watched(p: Person) {
		const n = p.episodesWatched;
		const upTo = p.furthest ? ` · up to ${episodeCode(p.furthest.season, p.furthest.episode)}` : '';
		return `Watched ${n} ${n === 1 ? 'episode' : 'episodes'}${upTo}`;
	}
</script>

<section class="mt-8">
	<h2 class="mb-3 text-lg font-semibold">Household</h2>
	<ul class="space-y-3">
		{#each people as p (p.userId)}
			{@const label = statusLabel(p.status)}
			<li class="card p-4">
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span class="font-medium">{p.name}</span>
					{#if label}<span class="badge">{label}</span>{/if}
					<Rating value={p.rating} class="text-sm" />
					{#if p.favorite}
						<span class="text-rose-500" title="Favorite">
							<Icon name="heart" size={14} filled />
							<span class="sr-only">Favorite</span>
						</span>
					{/if}
					{#if p.lastLoggedAt}
						<span class="text-xs text-muted">{`Last logged ${pretty(p.lastLoggedAt)}`}</span>
					{/if}
					{#if p.plays}
						<span class="text-xs text-muted"
							>{`🎧 ${p.plays.toLocaleString()} ${p.plays === 1 ? 'play' : 'plays'}`}</span
						>
					{/if}
				</div>
				{#if p.watching && stillWatching(p.watching)}
					<p class="mt-1 flex items-center gap-1 text-sm font-medium text-accent tabular-nums">
						<Icon name={p.watching.pausedAt === null ? 'play' : 'pause'} size={14} class="shrink-0" />
						{watchingNow(p.watching)}
					</p>
				{/if}
				{#if tracked && p.episodesWatched > 0}
					<p class="mt-1 flex items-center gap-1 text-sm text-muted">
						<Icon name="check" size={14} class="shrink-0 text-accent" />
						{watched(p)}
					</p>
				{/if}
				{#if p.notes}<p class="mt-2 text-sm whitespace-pre-line">{p.notes}</p>{/if}
				{#if p.logs.length}
					<details class="mt-3">
						<summary class="cursor-pointer text-sm font-medium text-accent">
							{p.logCount}
							{p.logCount === 1 ? 'log' : 'logs'}
						</summary>
						<ol class="mt-3 space-y-3 border-l-2 border-border pl-4">
							{#each p.logs as log (log.id)}
								{@const episode = logEpisodeLabel(log.episodes)}
								<li class="text-sm">
									<div class="flex items-start gap-3">
										<div class="min-w-0 flex-1">
											<p class="font-medium">{pretty(log.date)}</p>
											{#if log.external?.lastfm}
												<p class="text-muted">
													{`${log.external.lastfm.plays.toLocaleString()} ${log.external.lastfm.plays === 1 ? 'track' : 'tracks'} · last.fm`}
												</p>
											{/if}
											{#if episode}
												<p class="flex items-center gap-1">
													<Icon name="check" size={14} class="shrink-0 text-accent" />
													<span>{episode}</span>
												</p>
											{/if}
											{#if log.location}
												<p class="flex items-center gap-1 text-muted">
													<Icon name="pin" size={14} />
													{log.location}
												</p>
											{/if}
										</div>
										<Rating value={log.rating} />
									</div>
									{#each logFields.filter((f) => log.custom[f.key] !== undefined && log.custom[f.key] !== '') as f (f.key)}
										<p class="mt-1">
											<span class="text-muted">{f.label}:</span>
											<span class="whitespace-pre-line">{formatFieldValue(f, log.custom[f.key])}</span>
										</p>
									{/each}
									{#if log.notes}<p class="mt-1 whitespace-pre-line">{log.notes}</p>{/if}
								</li>
							{/each}
						</ol>
						{#if p.logCount > p.logs.length}
							<p class="hint">{`The latest ${p.logs.length} of ${p.logCount}.`}</p>
						{/if}
					</details>
				{/if}
			</li>
		{/each}
	</ul>
</section>
