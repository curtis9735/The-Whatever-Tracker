<script lang="ts">
	import { RANGES, rangeLabel, shortDate, type DateRange } from '$lib/journal';
	import Icon from './Icon.svelte';

	let {
		range,
		today,
		keep = {}
	}: {
		range: DateRange;
		today: string;
		/** Other query parameters to carry along (e.g. the list filter) */
		keep?: Record<string, string>;
	} = $props();

	let open = $state(false);
	let tab = $state<'preset' | 'custom'>('preset');
	let root = $state<HTMLDivElement>();

	const hrefFor = (key: string) => `?${new URLSearchParams({ range: key, ...keep })}`;

	function toggle() {
		open = !open;
		if (open) tab = range.key === 'custom' ? 'custom' : 'preset';
	}
</script>

<svelte:window
	onclick={(e) => open && root && !root.contains(e.target as Node) && (open = false)}
	onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

<div class="relative" bind:this={root}>
	<button type="button" class="btn" aria-expanded={open} aria-haspopup="dialog" onclick={toggle}>
		<Icon name="calendar" size={16} class="text-accent" />
		{rangeLabel(range)}
		<Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
	</button>

	{#if open}
		<div
			class="absolute top-full left-0 z-30 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
			role="dialog"
			aria-label="Choose dates"
		>
			<div class="grid grid-cols-2 border-b border-border text-sm font-medium" role="tablist">
				{#each [['preset', 'Predefined Ranges'], ['custom', 'Custom Range']] as const as [key, label] (key)}
					<button
						type="button"
						role="tab"
						aria-selected={tab === key}
						class="border-b-2 px-3 py-3 {tab === key
							? 'border-accent text-fg'
							: 'border-transparent text-muted hover:text-fg'}"
						onclick={() => (tab = key)}
					>
						{label}
					</button>
				{/each}
			</div>

			{#if tab === 'preset'}
				<div class="grid grid-cols-2 gap-1 p-2">
					{#each RANGES as r (r.key)}
						{@const active = range.key === r.key}
						<a
							href={hrefFor(r.key)}
							class="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm {active
								? 'bg-accent font-medium text-accent-fg'
								: 'hover:bg-surface-2'}"
							aria-current={active ? 'true' : undefined}
							onclick={() => (open = false)}
						>
							{r.label}
							{#if active}<Icon name="check" size={16} />{/if}
						</a>
					{/each}
				</div>
			{:else}
				<form method="GET" class="space-y-3 p-4" onsubmit={() => (open = false)}>
					{#each Object.entries(keep) as [name, value] (name)}
						<input type="hidden" {name} {value} />
					{/each}
					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="label" for="range-from">From</label>
							<input class="input" id="range-from" name="from" type="date" value={range.from} required />
						</div>
						<div>
							<label class="label" for="range-to">To</label>
							<input class="input" id="range-to" name="to" type="date" value={range.to} required />
						</div>
					</div>
					<p class="text-xs text-muted">Today is {shortDate(today)}.</p>
					<button class="btn btn-primary w-full">Show these dates</button>
				</form>
			{/if}
		</div>
	{/if}
</div>
