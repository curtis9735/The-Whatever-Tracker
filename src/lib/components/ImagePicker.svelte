<script lang="ts">
	import { onDestroy } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		prefix = 'img_',
		label = 'Photos',
		defaultUrl = ''
	}: { prefix?: string; label?: string; defaultUrl?: string } = $props();

	let previews = $state<{ key: string; url: string }[]>([]);
	let cameraInput: HTMLInputElement;
	let galleryInput: HTMLInputElement;
	// svelte-ignore state_referenced_locally
	let showUrl = $state(!!defaultUrl);

	function refresh() {
		for (const p of previews) URL.revokeObjectURL(p.url);
		const files = [...(cameraInput?.files ?? []), ...(galleryInput?.files ?? [])];
		previews = files.map((f, i) => ({ key: `${i}-${f.name}`, url: URL.createObjectURL(f) }));
	}

	function clearFiles() {
		if (cameraInput) cameraInput.value = '';
		if (galleryInput) galleryInput.value = '';
		refresh();
	}

	onDestroy(() => previews.forEach((p) => URL.revokeObjectURL(p.url)));
</script>

<div>
	<span class="label">{label}</span>
	<div class="flex flex-wrap gap-2">
		<label class="btn cursor-pointer">
			<Icon name="camera" size={18} /> Take photo
			<input
				bind:this={cameraInput}
				type="file"
				name="{prefix}files"
				accept="image/*"
				capture="environment"
				class="sr-only"
				onchange={refresh}
			/>
		</label>
		<label class="btn cursor-pointer">
			<Icon name="upload" size={18} /> Upload
			<input
				bind:this={galleryInput}
				type="file"
				name="{prefix}files"
				accept="image/*"
				multiple
				class="sr-only"
				onchange={refresh}
			/>
		</label>
		<button type="button" class="btn" onclick={() => (showUrl = !showUrl)} aria-expanded={showUrl}>
			<Icon name="link" size={18} /> From link
		</button>
	</div>

	{#if previews.length}
		<div class="mt-3 flex flex-wrap items-center gap-2">
			{#each previews as p (p.key)}
				<img src={p.url} alt="" class="h-20 w-20 rounded-lg border border-border object-cover" />
			{/each}
			<button type="button" class="btn btn-ghost btn-sm" onclick={clearFiles}>Remove</button>
		</div>
	{/if}

	{#if showUrl}
		<div class="mt-3 space-y-2">
			<input
				class="input"
				type="url"
				name="{prefix}url"
				inputmode="url"
				placeholder="https://example.com/photo.jpg"
				value={defaultUrl}
				aria-label="Image link"
			/>
			<label class="flex items-start gap-2 text-sm">
				<input type="checkbox" name="{prefix}link_only" class="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
				<span>
					Link only
					<span class="block text-xs text-muted">
						By default a copy is saved on your NAS so the picture never breaks. Tick this to just link to it.
					</span>
				</span>
			</label>
		</div>
	{/if}
</div>
