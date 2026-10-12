<script lang="ts">
	import { tick } from 'svelte';
	import { firstGrapheme, ICON_GROUPS, searchIcons, suggestIcons, type IconOption } from '$lib/icons';
	import Icon from './Icon.svelte';

	let {
		name = 'icon',
		value: current = $bindable('📦'),
		/** The list's name, used to suggest matching icons */
		hint = '',
		id = 'icon'
	}: { name?: string; value?: string; hint?: string; id?: string } = $props();

	let dialog: HTMLDialogElement;
	let search = $state<HTMLInputElement>();
	let query = $state('');
	let custom = $state('');

	const results = $derived(query.trim() ? searchIcons(query) : null);
	const suggestions = $derived(suggestIcons(hint));

	async function open() {
		query = '';
		custom = '';
		dialog.showModal();
		await tick();
		search?.focus();
	}

	function choose(emoji: string) {
		current = emoji;
		dialog.close();
	}

	function useCustom(e: Event) {
		e.preventDefault();
		const g = firstGrapheme(custom);
		if (g) choose(g);
	}
</script>

<input type="hidden" {name} value={current} />
<button
	type="button"
	{id}
	class="group relative flex h-11 w-full min-w-14 items-center justify-center rounded-xl border border-border bg-surface text-2xl hover:bg-surface-2 focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
	onclick={open}
	aria-label="Icon: {current}. Choose a different icon"
	title="Choose an icon"
>
	<span aria-hidden="true">{current}</span>
	<span
		class="absolute -right-1.5 -bottom-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted group-hover:text-fg"
		aria-hidden="true"
	>
		<Icon name="pencil" size={11} />
	</span>
</button>

<dialog
	bind:this={dialog}
	onclick={(e) => e.target === dialog && dialog.close()}
	class="m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border border-border bg-bg p-0 text-fg shadow-2xl backdrop:bg-black/50 md:m-auto md:max-h-[75vh] md:max-w-lg md:rounded-2xl"
	aria-label="Choose an icon"
>
	<div class="flex max-h-[85dvh] flex-col md:max-h-[75vh]">
		<div class="space-y-2 border-b border-border p-3">
			<div class="flex items-center gap-2">
				<h2 class="flex-1 font-semibold">Choose an icon</h2>
				<button
					type="button"
					class="btn btn-ghost btn-icon"
					onclick={() => dialog.close()}
					aria-label="Close"
				>
					<Icon name="x" />
				</button>
			</div>
			<div class="relative">
				<Icon name="search" size={16} class="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
				<input
					bind:this={search}
					bind:value={query}
					class="input pl-9"
					type="search"
					placeholder="Search: wine, cat, bottle, hiking…"
					aria-label="Search icons"
					autocomplete="off"
				/>
			</div>
		</div>

		<div class="flex-1 overflow-y-auto overscroll-contain p-3 pb-safe">
			{#if results}
				{#if results.length}
					{@render grid(results)}
				{:else}
					<p class="py-6 text-center text-sm text-muted">
						No icons match “{query}”. Paste any emoji below instead.
					</p>
				{/if}
			{:else}
				{#if suggestions.length}
					<h3 class="section-title mb-2">Suggested for “{hint.trim()}”</h3>
					<div class="mb-4">{@render grid(suggestions)}</div>
				{/if}
				{#each ICON_GROUPS as g (g.label)}
					<h3 class="section-title mb-2">{g.label}</h3>
					<div class="mb-4">{@render grid(g.icons)}</div>
				{/each}
			{/if}
		</div>

		<form class="flex items-center gap-2 border-t border-border p-3" onsubmit={useCustom}>
			<input
				class="input w-20 text-center text-xl"
				bind:value={custom}
				placeholder="🙂"
				aria-label="Any emoji"
				autocomplete="off"
			/>
			<p class="flex-1 text-xs text-muted">
				Or type or paste any emoji.
				<span class="hidden md:inline">
					On Windows, <kbd class="rounded border border-border px-1">Win</kbd> +
					<kbd class="rounded border border-border px-1">.</kbd> opens the emoji keyboard.
				</span>
			</p>
			<button class="btn btn-sm" disabled={!custom.trim()}>Use</button>
		</form>
	</div>
</dialog>

{#snippet grid(icons: IconOption[])}
	<div class="grid grid-cols-8 gap-1 sm:grid-cols-10">
		{#each icons as i (i.emoji)}
			<button
				type="button"
				class="flex aspect-square items-center justify-center rounded-lg text-2xl hover:bg-surface-2 focus:bg-surface-2 focus:outline-none {current ===
				i.emoji
					? 'bg-accent-soft ring-2 ring-accent'
					: ''}"
				onclick={() => choose(i.emoji)}
				title={i.name}
				aria-label={i.name}
				aria-pressed={current === i.emoji}
			>
				{i.emoji}
			</button>
		{/each}
	</div>
{/snippet}
