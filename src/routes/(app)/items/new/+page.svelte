<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ImagePicker from '$lib/components/ImagePicker.svelte';
	import ItemForm from '$lib/components/ItemForm.svelte';
	import LogFields from '$lib/components/LogFields.svelte';

	let { data, form } = $props();
	const cat = $derived(data.chosen.category);
	let addLog = $state(false);
	let busy = $state(false);

	function switchCategory(slug: string) {
		const sp = new URLSearchParams(page.url.searchParams);
		sp.set('category', slug);
		// Keep what was typed so far when the form re-renders for the other list
		for (const name of ['title', 'subtitle', 'barcode'] as const) {
			const el = document.getElementById(name) as HTMLInputElement | null;
			if (el?.value) sp.set(name, el.value);
		}
		goto(`?${sp}`, { replaceState: true, keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>New {cat.name} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-2xl">
	<h1 class="mb-5 text-2xl font-semibold tracking-tight">Add to {cat.icon} {cat.name}</h1>

	<div class="mb-5">
		<label class="label" for="category-switch">List</label>
		<select
			class="input"
			id="category-switch"
			value={cat.slug}
			onchange={(e) => switchCategory((e.currentTarget as HTMLSelectElement).value)}
		>
			{#each data.categories as c (c.id)}<option value={c.slug}>{c.icon} {c.name}</option>{/each}
		</select>
		{#if cat.providerKinds.length && data.searchKinds.some((k) => cat.providerKinds.includes(k))}
			<p class="hint">Tip: use Search to fill in details and artwork automatically.</p>
		{/if}
	</div>

	<form
		method="POST"
		enctype="multipart/form-data"
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
				itemFields={data.chosen.itemFields}
				allTags={data.allTags}
				values={{
					title: data.defaults.title,
					subtitle: data.defaults.subtitle,
					barcode: data.defaults.barcode,
					status: cat.statuses[0]?.key
				}}
			/>
		{/key}

		<div class="card p-4">
			<ImagePicker prefix="img_" label="Photos" defaultUrl={data.defaults.image} />
		</div>

		<div class="card p-4">
			<label class="flex items-center gap-3 font-medium">
				<input type="checkbox" name="add_log" bind:checked={addLog} class="h-5 w-5 accent-[var(--accent)]" />
				Log it now (watched, played, tasted, met…)
			</label>
			{#if addLog}
				<div class="mt-4 space-y-4">
					{#key cat.id}
						<LogFields scale={cat.ratingScale} logFields={data.chosen.logFields} dateDefault={data.today} />
					{/key}
					<ImagePicker prefix="logimg_" label="Photos from this time" />
				</div>
			{/if}
		</div>

		<div class="sticky bottom-20 flex gap-3 md:bottom-4">
			<button class="btn btn-primary flex-1 shadow-lg sm:flex-none" disabled={busy}>
				{busy ? 'Saving…' : 'Save'}
			</button>
			<a class="btn shadow-lg" href="/c/{cat.slug}">Cancel</a>
		</div>
	</form>
</div>
