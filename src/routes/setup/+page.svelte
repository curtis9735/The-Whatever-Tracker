<script lang="ts">
	import { enhance } from '$app/forms';
	import AuthShell from '$lib/components/AuthShell.svelte';

	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Set up · The Whatever Tracker</title></svelte:head>

<AuthShell
	title="Set up your tracker"
	subtitle="Create the admin account. You can add household members after."
>
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
		<div>
			<label class="label" for="code">Setup code</label>
			<input
				class="input font-mono tracking-widest uppercase"
				id="code"
				name="code"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				required
			/>
			<p class="hint">Printed in the container logs when the app starts with no accounts.</p>
		</div>
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
			<label class="label" for="displayName">Display name</label>
			<input class="input" id="displayName" name="displayName" value={form?.displayName ?? ''} />
		</div>
		<div>
			<label class="label" for="password">Password</label>
			<input
				class="input"
				id="password"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength="8"
				required
			/>
		</div>
		<div>
			<label class="label" for="confirm">Confirm password</label>
			<input
				class="input"
				id="confirm"
				name="confirm"
				type="password"
				autocomplete="new-password"
				minlength="8"
				required
			/>
		</div>
		<button class="btn btn-primary w-full" disabled={busy}
			>{busy ? 'Creating…' : 'Create admin account'}</button
		>
	</form>
</AuthShell>
