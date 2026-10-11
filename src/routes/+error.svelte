<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · The Whatever Tracker</title></svelte:head>

<main class="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
	<p class="text-5xl" aria-hidden="true">🫥</p>
	<h1 class="text-2xl font-semibold">{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
	<p class="max-w-md text-sm text-muted">{page.error?.message}</p>
	<a href="/" class="btn btn-primary mt-2">Go home</a>
</main>
