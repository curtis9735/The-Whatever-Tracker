<script lang="ts">
	import { goto } from '$app/navigation';
	import BarcodeScanner from '$lib/components/BarcodeScanner.svelte';

	let busy = $state(false);
	let message = $state('');
	let matches = $state<{ id: number; title: string; categoryIcon: string; categoryName: string }[]>([]);
	let attempt = $state(0);

	async function onResult(code: string) {
		busy = true;
		message = '';
		try {
			const res = await fetch(`/api/barcode/${code}`);
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Lookup failed');
			if (d.library.length === 1) return goto(`/items/${d.library[0].id}`);
			if (d.library.length > 1) {
				matches = d.library;
				return;
			}
			const params = new URLSearchParams({ barcode: code });
			if (d.product) {
				params.set('title', d.product.title);
				if (d.product.brand) params.set('subtitle', d.product.brand);
				if (d.product.imageUrl) params.set('image', d.product.imageUrl);
			}
			await goto(`/items/new?${params}`);
		} catch (e) {
			message = (e as Error).message;
			attempt++;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Scan · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-md">
	<h1 class="mb-1 text-2xl font-semibold tracking-tight">Scan a barcode</h1>
	<p class="mb-5 text-sm text-muted">Finds it in your lists first, then looks it up on Open Food Facts.</p>
	{#if message}<p class="error-box mb-4">{message}</p>{/if}
	{#if matches.length}
		<p class="mb-2 text-sm">You already have this in several places:</p>
		<ul class="card mb-4 divide-y divide-border">
			{#each matches as m (m.id)}
				<li><a class="block p-3 hover:bg-surface-2" href="/items/{m.id}">{m.categoryIcon} {m.title}</a></li>
			{/each}
		</ul>
	{:else if busy}
		<p class="py-10 text-center text-sm text-muted">Looking it up…</p>
	{:else}
		{#key attempt}
			<BarcodeScanner onresult={onResult} oncancel={() => history.back()} />
		{/key}
	{/if}
</div>
