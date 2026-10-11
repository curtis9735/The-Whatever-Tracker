<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();
</script>

<svelte:head><title>Lists · The Whatever Tracker</title></svelte:head>

<div class="mb-5 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Your lists</h1>
	<a href="/categories/new" class="btn btn-primary"><Icon name="plus" size={18} /> New list</a>
</div>

{#if data.categories.length === 0}
	<p class="text-sm text-muted">No lists yet.</p>
{:else}
	<ul class="card divide-y divide-border">
		{#each data.categories as c, i (c.id)}
			<li class="flex items-center gap-3 p-3">
				<a href="/c/{c.slug}" class="flex min-w-0 flex-1 items-center gap-3">
					<span
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl"
						style="background: color-mix(in srgb, {categoryColor(c.color)} 16%, transparent)"
						aria-hidden="true">{c.icon}</span
					>
					<span class="min-w-0">
						<span class="block truncate font-medium">{c.name}</span>
						<span class="text-xs text-muted">{c.itemCount} items</span>
					</span>
				</a>
				<form method="POST" action="?/move" use:enhance class="flex">
					<input type="hidden" name="id" value={c.id} />
					<button
						name="dir"
						value="up"
						class="btn btn-ghost btn-icon"
						disabled={i === 0}
						aria-label="Move {c.name} up"
					>
						<Icon name="chevron-up" size={18} />
					</button>
					<button
						name="dir"
						value="down"
						class="btn btn-ghost btn-icon"
						disabled={i === data.categories.length - 1}
						aria-label="Move {c.name} down"
					>
						<Icon name="chevron-down" size={18} />
					</button>
				</form>
				<a href="/categories/{c.slug}/edit" class="btn btn-sm">Edit</a>
			</li>
		{/each}
	</ul>
{/if}
