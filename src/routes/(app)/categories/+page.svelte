<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { categoryColor } from '$lib/kinds';

	let { data } = $props();
	// The viewer's own lists (in their order), then the ones others share with them
	const own = $derived(data.categories.filter((c) => c.access === 'owner'));
	const shared = $derived(data.categories.filter((c) => c.access !== 'owner'));
</script>

<svelte:head><title>Lists · The Whatever Tracker</title></svelte:head>

<div class="mb-5 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Your lists</h1>
	<a href="/categories/new" class="btn btn-primary"><Icon name="plus" size={18} /> New list</a>
</div>

{#if own.length === 0}
	<p class="text-sm text-muted">No lists yet.</p>
{:else}
	<ul class="card divide-y divide-border">
		{#each own as c, i (c.id)}
			<li class="flex items-center gap-3 p-3">
				<a href="/c/{c.slug}" class="flex min-w-0 flex-1 items-center gap-3">
					{@render listIcon(c.icon, c.color)}
					<span class="min-w-0">
						<span class="block truncate font-medium">{c.name}</span>
						<span class="flex items-center gap-2 text-xs text-muted">
							{`${c.itemCount} ${c.itemCount === 1 ? 'item' : 'items'}`}
							{#if c.sharedWith > 0}
								<span
									class="badge gap-1"
									title="Shared with {c.sharedWith} {c.sharedWith === 1 ? 'person' : 'people'}"
								>
									<Icon name="users" size={12} /> Shared
								</span>
							{/if}
						</span>
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
						disabled={i === own.length - 1}
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

{#if shared.length}
	<h2 class="section-title mt-8 mb-2">Shared with you</h2>
	<ul class="card divide-y divide-border">
		{#each shared as c (c.id)}
			<li class="flex items-center gap-3 p-3">
				<a href="/c/{c.slug}" class="flex min-w-0 flex-1 items-center gap-3">
					{@render listIcon(c.icon, c.color)}
					<span class="min-w-0">
						<span class="block truncate font-medium">{c.name}</span>
						<span class="block truncate text-xs text-muted">
							{`${c.ownerName}'s · ${c.itemCount} ${c.itemCount === 1 ? 'item' : 'items'} · ${c.access === 'edit' ? 'Can edit' : 'Can view'}`}
						</span>
					</span>
				</a>
				<a href="/categories/{c.slug}/edit" class="btn btn-sm">Settings</a>
			</li>
		{/each}
	</ul>
{/if}

{#snippet listIcon(icon: string, color: string)}
	<span
		class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl"
		style="background: color-mix(in srgb, {categoryColor(color)} 16%, transparent)"
		aria-hidden="true">{icon}</span
	>
{/snippet}
