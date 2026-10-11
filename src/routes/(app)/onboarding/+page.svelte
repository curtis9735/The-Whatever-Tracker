<script lang="ts">
	let { data } = $props();
	const defaults = new Set(['movies', 'tv-shows', 'video-games', 'board-games', 'concerts', 'whiskey']);
</script>

<svelte:head><title>Pick your lists · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl">
	<h1 class="text-2xl font-semibold tracking-tight">What do you want to track?</h1>
	<p class="mt-1 mb-6 text-sm text-muted">
		Pick some starting lists. Everything is editable later: rename them, change fields, or make your own from
		scratch.
	</p>

	<form method="POST">
		<div class="grid gap-3 sm:grid-cols-2">
			{#each data.templates as t (t.key)}
				<label
					class="card flex cursor-pointer items-start gap-3 p-4 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
				>
					<input
						type="checkbox"
						name="templates"
						value={t.key}
						class="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
						checked={!t.exists && defaults.has(t.key)}
						disabled={t.exists}
					/>
					<span class="text-2xl" aria-hidden="true">{t.icon}</span>
					<span class="min-w-0">
						<span class="block font-medium">{t.name}{t.exists ? ' (already added)' : ''}</span>
						<span class="block text-sm text-muted">{t.description}</span>
						{#if t.needsSource && !t.sourceReady}
							<span class="mt-1 block text-xs text-amber-600 dark:text-amber-400">
								Metadata search needs an API key (see Settings → Integrations). You can still add items by
								hand.
							</span>
						{/if}
					</span>
				</label>
			{/each}
		</div>
		<div class="sticky bottom-20 mt-6 flex gap-3 md:bottom-4">
			<button class="btn btn-primary flex-1 shadow-lg sm:flex-none">Create selected lists</button>
		</div>
	</form>
</div>
