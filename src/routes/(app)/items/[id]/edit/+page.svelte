<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import ItemForm from '$lib/components/ItemForm.svelte';
	import { PROGRESS_KEYS } from '$lib/episodes';

	let { data, form } = $props();
	const cat = $derived(data.target.category);
	let busy = $state(false);
</script>

<svelte:head><title>Edit {data.item.title} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<h1 class="mb-5 text-2xl font-semibold tracking-tight">Edit</h1>

	<div class="mb-5">
		<label class="label" for="move">List</label>
		<select
			class="input"
			id="move"
			value={cat.id}
			onchange={(e) =>
				goto(`?move=${(e.currentTarget as HTMLSelectElement).value}`, { replaceState: true, noScroll: true })}
		>
			{#each data.categories as c (c.id)}<option value={c.id}>{c.icon} {c.name}</option>{/each}
		</select>
		{#if cat.id !== data.item.categoryId}
			<p class="hint">
				Saving moves this item to {cat.name}. Its status is reset if {cat.name} uses different statuses.
			</p>
		{/if}
	</div>

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
		{#key cat.id}
			<ItemForm
				category={cat}
				itemFields={data.tracked
					? data.target.itemFields.filter((f) => !PROGRESS_KEYS.includes(f.key))
					: data.target.itemFields}
				allTags={data.allTags}
				values={{ ...data.item, tags: data.tags }}
			/>
		{/key}
		<div class="sticky bottom-20 flex gap-3 md:bottom-4">
			<button class="btn btn-primary flex-1 shadow-lg sm:flex-none" disabled={busy}
				>{busy ? 'Saving…' : 'Save changes'}</button
			>
			<a class="btn shadow-lg" href="/items/{data.item.id}">Cancel</a>
		</div>
	</form>
</div>
