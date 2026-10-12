<script lang="ts">
	import IconPicker from '$lib/components/IconPicker.svelte';
	import { suggestIcons } from '$lib/icons';

	let { data, form } = $props();

	let name = $state('');
	let icon = $state('📦');
	const suggestions = $derived(suggestIcons(name, 8));
</script>

<svelte:head><title>New list · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl">
	<h1 class="mb-5 text-2xl font-semibold tracking-tight">New list</h1>
	{#if form?.message}<p class="error-box mb-4">{form.message}</p>{/if}

	<section class="card mb-8 p-4">
		<h2 class="mb-1 font-medium">Start from scratch</h2>
		<p class="mb-4 text-sm text-muted">
			Anything at all: perfumes, hikes, coffee beans, ramen shops. You'll add your own fields next.
		</p>
		<form method="POST" action="?/blank">
			<div class="flex gap-2">
				<div class="w-16 shrink-0">
					<IconPicker name="icon" id="new-icon" bind:value={icon} hint={name} />
				</div>
				<input
					class="input min-w-0 flex-1"
					name="name"
					bind:value={name}
					placeholder="e.g. Coffee beans"
					required
					maxlength="60"
					aria-label="List name"
				/>
				<button class="btn btn-primary">Create</button>
			</div>
			{#if suggestions.length}
				<div class="mt-3 flex flex-wrap items-center gap-1">
					<span class="mr-1 text-xs text-muted">Suggested icons:</span>
					{#each suggestions as s (s.emoji)}
						<button
							type="button"
							class="flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-surface-2 {icon ===
							s.emoji
								? 'bg-accent-soft ring-2 ring-accent'
								: ''}"
							onclick={() => (icon = s.emoji)}
							title={s.name}
							aria-label="Use {s.name} icon"
							aria-pressed={icon === s.emoji}
						>
							{s.emoji}
						</button>
					{/each}
				</div>
			{/if}
		</form>
	</section>

	<h2 class="section-title mb-3">Or use a template</h2>
	<div class="grid gap-3 sm:grid-cols-2">
		{#each data.templates as t (t.key)}
			<form method="POST" action="?/template">
				<input type="hidden" name="template" value={t.key} />
				<button class="card flex w-full items-start gap-3 p-4 text-left hover:bg-surface-2">
					<span class="text-2xl" aria-hidden="true">{t.icon}</span>
					<span>
						<span class="block font-medium">{t.name}</span>
						<span class="block text-sm text-muted">{t.description}</span>
					</span>
				</button>
			</form>
		{/each}
	</div>
</div>
