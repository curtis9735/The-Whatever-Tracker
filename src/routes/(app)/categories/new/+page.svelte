<script lang="ts">
	let { data, form } = $props();
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
		<form method="POST" action="?/blank" class="flex flex-wrap gap-2">
			<input
				class="input w-16 text-center text-xl"
				name="icon"
				value="📦"
				maxlength="8"
				aria-label="Icon (emoji)"
			/>
			<input
				class="input min-w-0 flex-1"
				name="name"
				placeholder="e.g. Coffee beans"
				required
				maxlength="60"
				aria-label="List name"
			/>
			<button class="btn btn-primary">Create</button>
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
