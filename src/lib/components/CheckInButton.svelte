<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { formatLength } from '$lib/watching';
	import { watchForms } from '$lib/watching-ui.svelte';
	import Icon from './Icon.svelte';

	// "Check in": starts a live check-in (Watching now) for a movie, or for an episode of a show.
	// While another one is running, offers to mark that one watched or cancel it first.

	let {
		itemId,
		pick = null,
		minutes = null,
		cls = 'btn btn-primary',
		disabled = false,
		onchanged,
		onbusy
	}: {
		itemId: number;
		/** Shows: the episode */
		pick?: { season: number; episode: number } | null;
		/** Its length, when known */
		minutes?: number | null;
		cls?: string;
		/** Another of the page's forms is being saved (the tracker's Mark watched) */
		disabled?: boolean;
		onchanged?: () => void;
		/** Told while a check-in is being saved, so the page's other forms can wait */
		onbusy?: (busy: boolean) => void;
	} = $props();

	const forms = watchForms(() => onchanged?.());
	const ui = forms.ui;
	$effect(() => {
		const busy = ui.busy;
		untrack(() => onbusy?.(busy));
	});
</script>

{#snippet fields(replace: string | null)}
	<input type="hidden" name="itemId" value={itemId} />
	{#if pick}
		<input type="hidden" name="season" value={pick.season} />
		<input type="hidden" name="episode" value={pick.episode} />
	{/if}
	{#if replace}<input type="hidden" name="replace" value={replace} />{/if}
{/snippet}

<form method="POST" action="/watching?/start" use:enhance={forms.submit()}>
	{@render fields(null)}
	<button class={cls} disabled={ui.busy || disabled}>
		<Icon name="play" size={16} />
		{ui.busy ? 'Checking in…' : 'Check in'}
		{#if minutes && !ui.busy}
			<span class="text-xs font-normal opacity-80 tabular-nums">{formatLength(minutes * 60_000)}</span>
		{/if}
	</button>
</form>

{#if ui.conflict}
	{@const c = ui.conflict}
	<div class="order-last basis-full rounded-xl border border-border p-3 text-sm" role="alert">
		<p>
			{`You're watching ${c.title}${c.label ? ` · ${c.label}` : ''}.`}
		</p>
		<div class="mt-2 flex flex-wrap gap-2">
			<form method="POST" action="/watching?/start" use:enhance={forms.submit()}>
				{@render fields('finish')}
				<button class="btn btn-primary btn-sm" disabled={ui.busy || disabled}
					>Mark it watched and check in</button
				>
			</form>
			<form method="POST" action="/watching?/start" use:enhance={forms.submit()}>
				{@render fields('cancel')}
				<button class="btn btn-sm" disabled={ui.busy || disabled}>Cancel it and check in</button>
			</form>
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (ui.conflict = null)}
				>Never mind</button
			>
		</div>
	</div>
{/if}
{#if ui.problem}<p class="error-box order-last basis-full" role="alert">{ui.problem}</p>{/if}
