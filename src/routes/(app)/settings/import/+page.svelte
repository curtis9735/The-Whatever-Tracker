<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';

	let { form } = $props();
	let busy = $state(false);

	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};
</script>

<svelte:head><title>Import from Yamtrack · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-2xl space-y-6">
	<a href="/settings" class="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
		<Icon name="chevron-left" size={16} /> Settings
	</a>
	<h1 class="text-2xl font-semibold tracking-tight">Import from Yamtrack</h1>

	{#if form?.message}<p class="error-box">{form.message}</p>{/if}

	{#if form?.done}
		<div class="card space-y-3 p-5">
			<p class="ok-box">Import finished.</p>
			<ul class="text-sm">
				<li><strong>{form.done.created}</strong> new items</li>
				<li><strong>{form.done.updated}</strong> existing items updated</li>
				<li><strong>{form.done.logsAdded}</strong> logs added</li>
				{#if form.done.episodesAdded}
					<li><strong>{form.done.episodesAdded}</strong> TV episodes marked watched</li>
				{/if}
				{#if form.done.createdCategories.length}
					<li>New lists: {form.done.createdCategories.join(', ')}</li>
				{/if}
			</ul>
			<a class="btn btn-primary" href="/">Go to your tracker</a>
		</div>
	{:else if form?.token}
		<div class="card space-y-4 p-5">
			<div>
				<p class="font-medium">{form.fileName}</p>
				<p class="text-sm text-muted">
					{form.rows} rows{form.skipped ? `, ${form.skipped} skipped (unsupported type)` : ''}. Nothing has
					been imported yet.
				</p>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-muted">
						<tr
							><th class="py-1 pr-3">Yamtrack</th><th class="pr-3">Goes into</th><th class="pr-3 text-right"
								>Items</th
							><th class="pr-3 text-right">Already here</th><th class="text-right">Logs</th></tr
						>
					</thead>
					<tbody class="divide-y divide-border">
						{#each form.summary as s (s.type)}
							<tr>
								<td class="py-2 pr-3">{s.label}</td>
								<td class="pr-3"
									>{s.category}{#if s.newCategory}<span class="badge ml-1">new list</span>{/if}</td
								>
								<td class="pr-3 text-right tabular-nums">{s.items}</td>
								<td class="pr-3 text-right tabular-nums">{s.existing}</td>
								<td class="text-right tabular-nums">{s.logs}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="text-xs text-muted">
				Items already in your tracker are updated, not duplicated, so it's safe to import the same file again.
				Seasons become logs. Episodes of shows from TMDB are marked watched on the day you watched them; other
				shows keep “current season / episode” progress.
			</p>
			<form method="POST" action="?/commit" use:enhance={submit} class="flex gap-2">
				<input type="hidden" name="token" value={form.token} />
				<button class="btn btn-primary" disabled={busy}>{busy ? 'Importing…' : 'Import now'}</button>
				<a class="btn" href="/settings/import">Choose another file</a>
			</form>
		</div>
	{:else}
		<div class="card space-y-4 p-5">
			<ol class="list-decimal space-y-1 pl-5 text-sm">
				<li>In Yamtrack, open <strong>Settings → Import / Export</strong> and export to CSV.</li>
				<li>Choose that file here. You'll see a preview before anything is saved.</li>
			</ol>
			<form
				method="POST"
				action="?/preview"
				enctype="multipart/form-data"
				use:enhance={submit}
				class="space-y-3"
			>
				<input
					class="input py-2"
					type="file"
					name="file"
					accept=".csv,text/csv"
					required
					aria-label="Yamtrack CSV file"
				/>
				<button class="btn btn-primary" disabled={busy}>{busy ? 'Reading…' : 'Preview import'}</button>
			</form>
		</div>
	{/if}
</div>
