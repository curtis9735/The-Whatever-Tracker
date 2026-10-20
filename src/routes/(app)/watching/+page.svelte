<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import WatchCard from '$lib/components/WatchCard.svelte';

	// The big view of the viewer's check-in (the app layout loads it, as `watching`)
	let { data } = $props();

	const w = $derived(data.watching);
</script>

<svelte:head><title>Watching now · The Whatever Tracker</title></svelte:head>

<h1 class="sr-only">Watching now</h1>

{#if w.live || w.finished}
	<div class="py-4 sm:py-8">
		<WatchCard live={w.live} finished={w.finished} serverNow={w.now} variant="full" />
	</div>
{:else}
	<div class="mx-auto max-w-sm py-16 text-center">
		<span
			class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted"
			aria-hidden="true"
		>
			<Icon name="play" size={28} />
		</span>
		<h2 class="mt-4 text-xl font-semibold tracking-tight">Nothing on right now</h2>
		<p class="mt-2 text-sm text-muted">
			Open a movie or show and tap Check in. A timer runs for its length, and when it's done it's marked
			watched on its own.
		</p>
		<a href="/" class="btn mt-6"><Icon name="home" size={16} /> Home</a>
	</div>
{/if}
