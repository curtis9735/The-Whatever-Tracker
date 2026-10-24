<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<!-- A standalone page: none of the signed-in app's navigation, and nothing to click that changes anything -->
<div class="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:py-10" data-sveltekit-preload-data="off">
	<main class="flex-1">{@render children()}</main>
	<footer class="mt-12 border-t border-border pt-4 text-center text-xs text-muted">
		Made with The Whatever Tracker
	</footer>
</div>
