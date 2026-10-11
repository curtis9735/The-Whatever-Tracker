<script lang="ts">
	import { enhance } from '$app/forms';
	import AuthShell from '$lib/components/AuthShell.svelte';

	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Sign in · The Whatever Tracker</title></svelte:head>

<AuthShell title="Welcome back" subtitle="Sign in to your tracker.">
	<form
		method="POST"
		class="space-y-4"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update();
				busy = false;
			};
		}}
	>
		{#if form?.message}<p class="error-box" role="alert">{form.message}</p>{/if}
		<div>
			<label class="label" for="username">Username</label>
			<input
				class="input"
				id="username"
				name="username"
				autocomplete="username"
				autocapitalize="none"
				spellcheck="false"
				required
				value={form?.username ?? ''}
			/>
		</div>
		<div>
			<label class="label" for="password">Password</label>
			<input
				class="input"
				id="password"
				name="password"
				type="password"
				autocomplete="current-password"
				required
			/>
		</div>
		<button class="btn btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
	</form>
</AuthShell>
