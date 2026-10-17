<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import ItemForm from '$lib/components/ItemForm.svelte';
	import RatingInput from '$lib/components/RatingInput.svelte';
	import { PROGRESS_KEYS } from '$lib/episodes';

	let { data, form } = $props();
	const cat = $derived(data.target.category);
	// On a shared list, status, favorite, rating and notes are each person's own
	const shared = $derived(cat.access !== 'owner' || cat.sharedWith > 0);
	let busy = $state(false);
</script>

<svelte:head
	><title>{data.canEdit ? 'Edit' : 'Your progress ·'} {data.item.title} · The Whatever Tracker</title
	></svelte:head
>

<div class="mx-auto max-w-2xl">
	{#if data.canEdit}
		<h1 class="mb-5 text-2xl font-semibold tracking-tight">Edit</h1>

		{#if data.lists.length > 1}
			<div class="mb-5">
				<label class="label" for="move">List</label>
				<select
					class="input"
					id="move"
					value={cat.id}
					onchange={(e) =>
						goto(`?move=${(e.currentTarget as HTMLSelectElement).value}`, {
							replaceState: true,
							noScroll: true
						})}
				>
					{#each data.lists as c (c.id)}<option value={c.id}>{c.icon} {c.name}</option>{/each}
				</select>
				{#if cat.id !== data.item.categoryId}
					<p class="hint">
						Saving moves this item to {cat.name}. A status {cat.name} doesn't have becomes its closest one, for
						everyone who has tracked it.
					</p>
				{/if}
			</div>
		{/if}

		<form
			method="POST"
			class="space-y-6"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<input type="hidden" name="categoryId" value={cat.id} />
			{#if form?.message}<p class="error-box" role="alert">{form.message}</p>{/if}
			{#if shared}
				<p class="hint">
					Status, favorite, rating and notes are just yours. Everything else changes the item for everyone
					with this list.
				</p>
			{/if}
			{#key cat.id}
				<ItemForm
					category={cat}
					itemFields={data.hideProgress
						? data.target.itemFields.filter((f) => !PROGRESS_KEYS.includes(f.key))
						: data.target.itemFields}
					allTags={data.allTags}
					values={{ ...data.item, tags: data.tags }}
					allowNoStatus={!data.item.status}
				/>
			{/key}
			<div class="sticky bottom-20 flex gap-3 md:bottom-4">
				<button class="btn btn-primary flex-1 shadow-lg sm:flex-none" disabled={busy}
					>{busy ? 'Saving…' : 'Save changes'}</button
				>
				<a class="btn shadow-lg" href="/items/{data.item.id}">Cancel</a>
			</div>
		</form>
	{:else}
		<!-- Shared to view: the item stays as it is; this is the viewer's own progress -->
		<h1 class="text-2xl font-semibold tracking-tight">Your progress</h1>
		<p class="mt-1 mb-5 text-muted">{data.item.title}</p>

		<form
			method="POST"
			class="space-y-4"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			{#if form?.message}<p class="error-box" role="alert">{form.message}</p>{/if}
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label class="label" for="status">Status</label>
					<select class="input" id="status" name="status" value={data.item.status ?? ''}>
						{#if !data.item.status}<option value="">No status</option>{/if}
						{#each cat.statuses as s (s.key)}<option value={s.key}>{s.label}</option>{/each}
					</select>
				</div>
				<div class="flex items-end">
					<label class="flex min-h-11 items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="favorite"
							class="h-5 w-5 accent-[var(--accent)]"
							checked={data.item.favorite}
						/>
						Favorite
					</label>
				</div>
			</div>
			<RatingInput value={data.item.rating} name="rating" label="Your rating" />
			<div>
				<label class="label" for="notes">Your notes</label>
				<textarea class="input" id="notes" name="notes" rows="4">{data.item.notes ?? ''}</textarea>
			</div>
			<p class="hint">
				{cat.ownerName} shared this list with you to view, so only your own progress changes here.
			</p>
			<div class="flex gap-3">
				<button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
				<a class="btn" href="/items/{data.item.id}">Cancel</a>
			</div>
		</form>
	{/if}
</div>
