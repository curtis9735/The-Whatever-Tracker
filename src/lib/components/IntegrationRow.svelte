<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';

	interface Field {
		key: string;
		label: string;
		secret: boolean;
		source: 'app' | 'stack' | null;
		/** Current value, masked if secret; only sent to admins */
		current: string | null;
	}

	let {
		integration: i,
		isAdmin,
		result
	}: {
		integration: {
			id: string;
			label: string;
			gives: string;
			howTo: string;
			docsUrl: string;
			enabled: boolean;
			testable: boolean;
			fields: Field[];
		};
		isAdmin: boolean;
		result: { success?: string; warning?: string; error?: string } | null;
	} = $props();

	let open = $state(false);
	let busy = $state<'' | 'save' | 'test' | 'clear'>('');
	let reveal = $state(false);

	// Keep the editor open to show the outcome of the last action
	$effect(() => {
		if (result) open = true;
	});

	const hasSaved = $derived(i.fields.some((f) => f.source === 'app'));
	const hasSecret = $derived(i.fields.some((f) => f.secret));
	const sourceText = $derived.by(() => {
		if (!i.fields.length) return 'Always on';
		if (!i.enabled) return 'Not set up';
		if (i.fields.every((f) => f.source === 'stack')) return 'Connected · from the Portainer stack';
		return 'Connected · saved in the app';
	});

	function sourceBadge(s: Field['source']) {
		return s === 'app' ? 'Saved in app' : s === 'stack' ? 'From stack' : 'Not set';
	}
</script>

<li class="py-3">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<span
			class="h-2.5 w-2.5 shrink-0 rounded-full {i.enabled ? 'bg-emerald-500' : 'bg-border'}"
			aria-hidden="true"
		></span>
		<span class="font-medium">{i.label}</span>
		<span class="text-sm text-muted">{i.gives}</span>
		<span class="ml-auto flex items-center gap-2">
			<span class="text-xs text-muted">{sourceText}</span>
			{#if isAdmin && i.fields.length}
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => (open = !open)}
					aria-expanded={open}
					aria-controls="integration-{i.id}"
				>
					{i.enabled ? 'Change' : 'Set up'}
				</button>
			{/if}
		</span>
	</div>

	{#if open && isAdmin && i.fields.length}
		<form
			id="integration-{i.id}"
			method="POST"
			action="?/saveIntegration"
			class="mt-3 space-y-3 rounded-xl border border-border bg-surface-2/50 p-3"
			use:enhance={({ action, cancel }) => {
				if (action.search.includes('clearIntegration')) {
					const msg = `Remove the ${i.label} key saved in the app? If the Portainer stack has one, that is used instead.`;
					if (!confirm(msg)) return cancel();
				}
				busy = action.search.includes('test') ? 'test' : action.search.includes('clear') ? 'clear' : 'save';
				return async ({ update }) => {
					await update();
					busy = '';
					reveal = false;
				};
			}}
		>
			<input type="hidden" name="integration" value={i.id} />
			{#each i.fields as f (f.key)}
				<div>
					<div class="mb-1 flex items-center justify-between gap-2">
						<label class="label mb-0" for="cred-{f.key}">{f.label}</label>
						<span class="badge">{sourceBadge(f.source)}</span>
					</div>
					<input
						class="input font-mono"
						id="cred-{f.key}"
						name={f.key}
						type={f.secret && !reveal ? 'password' : 'text'}
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						data-1p-ignore
						data-lpignore="true"
						placeholder={f.current ? `Current: ${f.current}` : 'Not set'}
					/>
				</div>
			{/each}
			<p class="hint mt-0">
				{i.howTo}
				<a class="text-accent underline" href={i.docsUrl} target="_blank" rel="noopener noreferrer">
					Open {i.label}
				</a>
			</p>
			<p class="hint mt-0">Leave a field blank to keep its current value.</p>

			<div class="flex flex-wrap gap-2">
				<button class="btn btn-primary btn-sm" disabled={!!busy}>
					{busy === 'save' ? 'Saving and testing…' : 'Save & test'}
				</button>
				{#if i.testable && i.enabled}
					<button class="btn btn-sm" formaction="?/testIntegration" formnovalidate disabled={!!busy}>
						{busy === 'test' ? 'Testing…' : 'Test current key'}
					</button>
				{/if}
				{#if hasSecret}
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => (reveal = !reveal)}>
						{reveal ? 'Hide' : 'Show'} what I type
					</button>
				{/if}
				{#if hasSaved}
					<button
						class="btn btn-ghost btn-sm text-danger"
						formaction="?/clearIntegration"
						formnovalidate
						disabled={!!busy}
					>
						<Icon name="trash" size={14} />
						{busy === 'clear' ? 'Removing…' : 'Remove saved key'}
					</button>
				{/if}
			</div>
		</form>
	{/if}

	{#if result?.success}<p class="ok-box mt-2">{result.success}</p>{/if}
	{#if result?.warning}<p
			class="error-box mt-2 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
		>
			{result.warning}
		</p>{/if}
	{#if result?.error}<p class="error-box mt-2" role="alert">{result.error}</p>{/if}
</li>
