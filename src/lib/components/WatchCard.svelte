<script lang="ts">
	import { enhance } from '$app/forms';
	import { imageSrc } from '$lib/images';
	import {
		formatLength,
		timeLeft,
		watchLabel,
		watchProgress,
		type FinishedCheckin,
		type LiveCheckin
	} from '$lib/watching';
	import { clockNow, clockReady, clockTime, watchForms } from '$lib/watching-ui.svelte';
	import Icon from './Icon.svelte';

	// A live check-in (Watching now) or one that just finished (Rate it / Undo). Three sizes:
	// 'bar' (the now-watching bar on every page), 'card' (the item page) and 'full' (/watching).

	let {
		live,
		finished = null,
		serverNow,
		variant = 'card',
		onchanged
	}: {
		live: LiveCheckin | null;
		finished?: FinishedCheckin | null;
		/** The server's time when the page was loaded (the layout's watching.now) */
		serverNow: number;
		variant?: 'bar' | 'card' | 'full';
		/** After any change (the episode tracker fetches its seasons again) */
		onchanged?: () => void;
	} = $props();

	const forms = watchForms(() => onchanged?.());
	const ui = forms.ui;

	const now = $derived(clockNow(serverNow));
	const target = $derived(live ?? finished);
	const label = $derived(target ? watchLabel(target) : null);
	const cover = $derived(target ? imageSrc(target.image, variant === 'full' ? 'full' : 'thumb') : null);
	const left = $derived(live ? timeLeft(live, now) : 0);
	const pct = $derived(live ? Math.round(watchProgress(live, now) * 100) : 0);
	const paused = $derived(live?.pausedAt != null);
	const finishing = $derived(!!live && !paused && left <= 0);

	/** "42 min left", "Paused · 42 min left", "about 45 min left" */
	const leftText = $derived.by(() => {
		if (!live) return '';
		if (finishing) return 'Finishing…';
		const t = `${live.runtimeKnown ? '' : 'about '}${formatLength(left)} left`;
		return paused ? `Paused · ${t}` : t;
	});
	/** What's announced (only when it changes, never the countdown) */
	const stateText = $derived(live ? (paused ? 'Paused' : 'Watching now') : finished ? 'Marked watched' : '');
	const watchedText = $derived(
		finished
			? `Watched ${finished.title}${label ? ` · ${label}` : ''}${finished.statusLabel ? ` · Now ${finished.statusLabel}` : ''}`
			: ''
	);
</script>

{#snippet poster(cls: string, iconCls: string)}
	<span class="flex shrink-0 items-center justify-center overflow-hidden bg-surface-2 {cls}">
		{#if cover}
			<img src={cover} alt="" class="h-full w-full object-cover" />
		{:else}
			<span class={iconCls} aria-hidden="true">{target?.categoryIcon}</span>
		{/if}
	</span>
{/snippet}

{#snippet progress(cls: string)}
	{#if live}
		<div
			class="overflow-hidden rounded-full bg-surface-2 {cls}"
			role="progressbar"
			aria-label="Time watched"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={pct}
			aria-valuetext={leftText}
		>
			<div class="h-full rounded-full bg-accent transition-[width] duration-1000" style="width: {pct}%"></div>
		</div>
	{/if}
{/snippet}

{#snippet pauseForm(cls: string, size: number, text: boolean)}
	{#if live}
		<form method="POST" action="/watching?/{paused ? 'resume' : 'pause'}" use:enhance={forms.submit()}>
			<input type="hidden" name="id" value={live.id} />
			<button class={cls} disabled={ui.busy} aria-label={paused ? 'Resume' : 'Pause'}>
				<Icon name={paused ? 'play' : 'pause'} {size} />
				{#if text}{paused ? 'Resume' : 'Pause'}{/if}
			</button>
		</form>
	{/if}
{/snippet}

{#snippet liveButtons(size: string)}
	{#if live}
		<div class="flex flex-wrap gap-2">
			{@render pauseForm(`btn ${size}`, 16, true)}
			<form method="POST" action="/watching?/finish" use:enhance={forms.submit()}>
				<input type="hidden" name="id" value={live.id} />
				<button class="btn btn-primary {size}" disabled={ui.busy}>
					<Icon name="check" size={16} /> Mark watched now
				</button>
			</form>
			<form
				method="POST"
				action="/watching?/cancel"
				use:enhance={forms.submit({ confirm: 'Cancel this check-in? Nothing is marked watched.' })}
			>
				<input type="hidden" name="id" value={live.id} />
				<button class="btn btn-ghost {size} text-danger" disabled={ui.busy}>
					<Icon name="x" size={16} /> Cancel check-in
				</button>
			</form>
		</div>
	{/if}
{/snippet}

<!-- Rate it, Undo and × for a check-in that just finished -->
{#snippet finishedActions(cls: string)}
	{#if finished}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 {cls}">
			{#if finished.logId}
				<a class="text-accent hover:underline" href="/logs/{finished.logId}/edit">Rate it</a>
			{/if}
			<form method="POST" action="/watching?/undo" use:enhance={forms.submit()}>
				<input type="hidden" name="id" value={finished.id} />
				<button class="text-accent hover:underline" disabled={ui.busy}>Undo</button>
			</form>
		</div>
	{/if}
{/snippet}

{#snippet dismissForm()}
	{#if finished}
		<form method="POST" action="/watching?/dismiss" use:enhance={forms.submit()}>
			<input type="hidden" name="id" value={finished.id} />
			<button class="btn btn-ghost btn-icon min-h-8 w-8 text-muted" disabled={ui.busy} aria-label="Dismiss">
				<Icon name="x" size={16} />
			</button>
		</form>
	{/if}
{/snippet}

{#if target}
	<p class="sr-only" aria-live="polite">{stateText}</p>

	{#if variant === 'bar'}
		<div
			class="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2 shadow-lg md:shadow-none"
		>
			{#if live}
				<a href="/watching" class="flex min-w-0 flex-1 items-center gap-3">
					{@render poster('h-12 w-9 rounded-md', 'text-lg')}
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{live.title}</span>
						{#if label}<span class="block truncate text-xs text-muted">{label}</span>{/if}
						{@render progress('mt-1 h-1')}
						<span class="mt-0.5 block text-xs text-muted tabular-nums">{leftText}</span>
					</span>
				</a>
				{@render pauseForm('btn btn-ghost btn-icon shrink-0', 20, false)}
			{:else if finished}
				<Icon name="check" size={18} class="ml-1 shrink-0 text-accent" />
				<div class="min-w-0 flex-1 text-sm">
					<a href="/items/{finished.itemId}" class="line-clamp-2 hover:underline">{watchedText}</a>
					{@render finishedActions('text-xs')}
				</div>
				{@render dismissForm()}
			{/if}
		</div>
	{:else if variant === 'card'}
		<div class="rounded-xl bg-accent-soft p-4">
			{#if live}
				<div class="flex items-baseline justify-between gap-3">
					<p class="text-xs font-semibold tracking-wide text-accent uppercase">
						{paused ? 'Paused' : 'Watching now'}
					</p>
					{#if !paused && clockReady()}
						<p class="text-xs text-muted tabular-nums">{`Ends ${clockTime(live.endsAt)}`}</p>
					{/if}
				</div>
				{#if label}<p class="mt-1 font-medium">{label}</p>{/if}
				{@render progress('mt-2 h-2')}
				<p class="mt-1 text-sm tabular-nums">{leftText}</p>
				<div class="mt-3">{@render liveButtons('btn-sm')}</div>
			{:else if finished}
				<div class="flex items-start gap-2 text-sm">
					<Icon name="check" size={16} class="mt-0.5 shrink-0 text-accent" />
					<div class="min-w-0 flex-1">
						<p>{watchedText}</p>
						{@render finishedActions('mt-1')}
					</div>
					{@render dismissForm()}
				</div>
			{/if}
		</div>
	{:else}
		<div class="mx-auto flex max-w-md flex-col items-center text-center">
			{@render poster('aspect-[2/3] w-44 rounded-2xl shadow-lg sm:w-56', 'text-6xl')}
			<p class="mt-6 text-xs font-semibold tracking-wide text-accent uppercase">
				{live ? (paused ? 'Paused' : 'Watching now') : 'Watched'}
			</p>
			<h2 class="mt-1 text-2xl leading-tight font-semibold tracking-tight">{target.title}</h2>
			{#if label}<p class="mt-1 text-muted">{label}</p>{/if}

			{#if live}
				<p class="mt-6 text-5xl font-semibold tracking-tight tabular-nums">
					{finishing ? 'Finishing…' : formatLength(left)}
				</p>
				{#if !finishing}
					<p class="mt-1 text-sm text-muted">
						{paused
							? 'left · Paused'
							: live.runtimeKnown
								? 'left'
								: 'left, roughly (TMDB doesn’t say how long it is)'}
					</p>
				{/if}
				{@render progress('mt-6 h-3 w-full')}
				<!-- Clock times once the browser's clock runs (the server's time zone may not be theirs) -->
				<p class="mt-3 min-h-5 text-sm text-muted tabular-nums">
					{#if clockReady()}
						{`Checked in ${clockTime(live.checkedInAt)}`}{paused ? '' : ` · ends ${clockTime(live.endsAt)}`}
					{/if}
				</p>
				<div class="mt-8 flex w-full flex-col gap-2">
					<form method="POST" action="/watching?/{paused ? 'resume' : 'pause'}" use:enhance={forms.submit()}>
						<input type="hidden" name="id" value={live.id} />
						<button class="btn min-h-12 w-full text-base" disabled={ui.busy}>
							<Icon name={paused ? 'play' : 'pause'} size={20} />
							{paused ? 'Resume' : 'Pause'}
						</button>
					</form>
					<form method="POST" action="/watching?/finish" use:enhance={forms.submit()}>
						<input type="hidden" name="id" value={live.id} />
						<button class="btn btn-primary min-h-12 w-full text-base" disabled={ui.busy}>
							<Icon name="check" size={20} /> Mark watched now
						</button>
					</form>
					<form
						method="POST"
						action="/watching?/cancel"
						use:enhance={forms.submit({ confirm: 'Cancel this check-in? Nothing is marked watched.' })}
					>
						<input type="hidden" name="id" value={live.id} />
						<button class="btn btn-ghost min-h-12 w-full text-base text-danger" disabled={ui.busy}>
							<Icon name="x" size={20} /> Cancel check-in
						</button>
					</form>
				</div>
			{:else if finished}
				<p class="mt-6 flex items-center gap-2">
					<Icon name="check" size={18} class="text-accent" />
					{finished.statusLabel ? `Marked watched · Now ${finished.statusLabel}` : 'Marked watched'}
				</p>
				<div class="mt-6 flex w-full flex-col gap-2">
					{#if finished.logId}
						<a class="btn btn-primary min-h-12 w-full text-base" href="/logs/{finished.logId}/edit">
							<Icon name="star" size={20} /> Rate it
						</a>
					{/if}
					<form method="POST" action="/watching?/undo" use:enhance={forms.submit()}>
						<input type="hidden" name="id" value={finished.id} />
						<button class="btn min-h-12 w-full text-base" disabled={ui.busy}>Undo</button>
					</form>
					<form method="POST" action="/watching?/dismiss" use:enhance={forms.submit()}>
						<input type="hidden" name="id" value={finished.id} />
						<button class="btn btn-ghost min-h-12 w-full text-base" disabled={ui.busy}>Dismiss</button>
					</form>
				</div>
			{/if}
			<a class="mt-6 text-sm text-accent hover:underline" href="/items/{target.itemId}">
				{`Open ${target.title}`}
			</a>
		</div>
	{/if}

	{#if ui.problem}<p class="error-box mt-2" role="alert">{ui.problem}</p>{/if}
{/if}
