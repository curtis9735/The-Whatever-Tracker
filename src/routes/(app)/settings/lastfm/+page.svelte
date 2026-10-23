<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form } = $props();

	type Status = NonNullable<typeof data.account>;

	// The status while the page is open: the load data, refreshed by polling while something runs
	// svelte-ignore state_referenced_locally
	let live = $state<Status | null>(data.account);
	$effect(() => {
		live = data.account;
	});
	const a = $derived(live);
	const running = $derived(!!a && a.state !== 'idle');
	/** Stuck on an error (the list one aside, which doesn't stop the reading): nothing is moving */
	const stuck = $derived(!!a?.error && a.error.code !== 'list');

	$effect(() => {
		if (!running) return;
		const t = setInterval(
			async () => {
				try {
					const res = await fetch('/api/lastfm/status', { cache: 'no-store' });
					if (!res.ok) return;
					const s = await res.json();
					if (!s.connected) {
						void invalidateAll();
						return;
					}
					const wasRunning = live?.state !== 'idle';
					live = s;
					// The import finished: the lists, counts and delete preview are new
					if (wasRunning && s.state === 'idle') void invalidateAll();
				} catch {
					/* offline for a moment: the next poll tries again */
				}
			},
			stuck ? 30_000 : 3000
		);
		return () => clearInterval(t);
	});

	const n = (v: number) => v.toLocaleString();
	const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

	function ago(ms: number) {
		const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
		if (min < 1) return 'just now';
		if (min < 60) return `${min} min ago`;
		if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
		return `${Math.round(min / 1440)} d ago`;
	}

	const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

	const statusLine = $derived.by(() => {
		if (!a) return '';
		if (a.state === 'importing') {
			const p = a.progress;
			if (!p) return 'Importing…';
			return p.total
				? `Importing… ${n(p.done)} of ${plural(p.total, 'play', 'plays')} (${a.percent ?? 0}%) · ${plural(p.albums, 'album', 'albums')} so far`
				: `Importing… ${plural(p.done, 'play', 'plays')} · ${plural(p.albums, 'album', 'albums')} so far`;
		}
		if (a.state === 'syncing') return 'Checking for new plays…';
		const parts = ['Up to date', plural(a.plays, 'play', 'plays'), plural(a.albums, 'album', 'albums')];
		if (a.lastSyncAt) parts.push(`last synced ${ago(a.lastSyncAt)}`);
		return parts.join(' · ');
	});

	// --- Connect form ---
	const defaultPick = $derived(
		String(
			data.lists.find((l) => l.isDefault)?.id ??
				(data.lists.some((l) => l.hasAlbumKind) ? data.lists.find((l) => l.hasAlbumKind)!.id : 'new')
		)
	);
	// svelte-ignore state_referenced_locally
	let pick = $state(defaultPick);
	// svelte-ignore state_referenced_locally
	let savePick = $state(String(data.account?.categoryId ?? ''));
	$effect(() => {
		savePick = String(data.account?.categoryId ?? '');
	});

	function warning(id: string) {
		const l = data.lists.find((x) => String(x.id) === id);
		if (!l || !l.otherPeople.length) return null;
		const names = l.otherPeople.join(' and ');
		return l.own
			? `${names} can see this list, so your albums will appear for them too.`
			: `This adds your albums to ${l.ownerName}'s list. ${names} and anyone else it's shared with will see them, without your plays.`;
	}
	const connectWarning = $derived(warning(pick));
	const saveWarning = $derived(a && savePick !== String(a.categoryId ?? '') ? warning(savePick) : null);

	let busy = $state('');
</script>

{#snippet deleteImported()}
	<form
		method="POST"
		action="?/deleteImported"
		use:enhance={({ cancel }) => {
			const p = data.deletePreview;
			const text = p
				? `Delete everything imported from last.fm? This removes ${plural(p.logs, 'listening log', 'listening logs')} and the ${plural(p.items, 'album', 'albums')} the import added that nobody has rated, noted or logged by hand. Albums you'd already added stay, and get back the status they had before. It then disconnects.`
				: 'Delete everything imported from last.fm?';
			if (!confirm(text)) cancel();
			return async ({ update }) => update();
		}}
		class="flex flex-wrap items-center gap-3"
	>
		<button class="btn btn-danger"><Icon name="trash" size={16} /> Delete imported listening…</button>
		<span class="text-sm text-muted">
			{data.deletePreview
				? `${plural(data.deletePreview.logs, 'log', 'logs')} and ${plural(data.deletePreview.items, 'album', 'albums')} would go.`
				: ''}
		</span>
	</form>
{/snippet}

<svelte:head><title>Your last.fm · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<div>
		<a class="text-sm text-muted hover:text-fg" href="/settings">← Settings</a>
		<h1 class="mt-1 text-2xl font-semibold tracking-tight">Your last.fm</h1>
	</div>

	{#if form?.connected}<p class="ok-box" role="status">{form.connected}</p>{/if}
	{#if form?.disconnected}<p class="ok-box" role="status">{form.disconnected}</p>{/if}
	{#if form?.deleted}
		<p class="ok-box" role="status">
			{`Removed ${plural(form.deleted.logs, 'listening log', 'listening logs')} and ${plural(form.deleted.items, 'album', 'albums')}. Disconnected.`}
		</p>
	{/if}

	{#if !data.lastfmReady && !a}
		<section class="card space-y-2 p-4 sm:p-5">
			<p class="text-sm text-muted">
				last.fm isn't set up yet. Ask an admin to add an API key.
				{#if data.isAdmin}
					<a class="text-accent underline" href="/settings#integrations">Add it under Integrations.</a>
				{/if}
			</p>
		</section>
	{:else if !a}
		<section class="card space-y-4 p-4 sm:p-5">
			<p class="text-sm text-muted">
				Every album you've listened to becomes part of a list, and each listening day becomes a log in your
				Journal. Your plays count as your own progress, also on lists you share.
			</p>
			<form
				method="POST"
				action="?/connect"
				use:enhance={() => {
					busy = 'connect';
					return async ({ update }) => {
						await update({ reset: false });
						busy = '';
					};
				}}
				class="space-y-4"
			>
				<div>
					<label class="label" for="username">last.fm username</label>
					<input
						class="input"
						id="username"
						name="username"
						value={form?.username ?? ''}
						pattern={String.raw`[A-Za-z][\w\-]{1,14}`}
						maxlength="15"
						autocomplete="off"
						autocapitalize="off"
						required
					/>
					<p class="hint">
						Your profile's listening history has to be public. Only you see your username here.
					</p>
				</div>
				<div>
					<label class="label" for="category">Put albums in</label>
					<select class="input" id="category" name="category" bind:value={pick}>
						{#each data.lists as l (l.id)}
							<option value={String(l.id)}>{l.icon} {l.name}{l.own ? '' : ` · ${l.ownerName}'s list`}</option>
						{/each}
						<option value="new">+ Create a 'Music' list</option>
					</select>
					{#if connectWarning}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300">
							{connectWarning}
						</p>{/if}
				</div>
				{#if form?.connectError}<p class="error-box" role="alert">{form.connectError}</p>{/if}
				<button class="btn btn-primary" disabled={busy === 'connect'}>
					<Icon name="music" size={16} />
					{busy === 'connect' ? 'Checking…' : 'Connect and import'}
				</button>
			</form>
		</section>
		{#if data.imported}
			<section class="card space-y-3 p-4 sm:p-5">
				<h2 class="font-semibold">Imported listening</h2>
				<p class="text-sm text-muted">
					Listening imported from last.fm is still here. To connect a different last.fm user, delete it first.
				</p>
				{@render deleteImported()}
			</section>
		{/if}
	{:else}
		<section class="card space-y-3 p-4 sm:p-5">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="font-semibold">Connected as {a.username}</h2>
				<form
					method="POST"
					action="?/sync"
					use:enhance={() =>
						async ({ update }) =>
							update({ reset: false })}
				>
					<button class="btn btn-sm" disabled={running && !stuck}
						><Icon name="refresh" size={14} /> Sync now</button
					>
				</form>
			</div>
			{#if running && !stuck}
				<div
					class="h-2 overflow-hidden rounded-full bg-surface-2"
					role="progressbar"
					aria-label="Import progress"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={a.percent ?? undefined}
				>
					<div
						class="h-full rounded-full bg-accent transition-all {a.percent === null
							? 'w-1/4 animate-pulse'
							: ''}"
						style={a.percent !== null ? `width: ${a.percent}%` : ''}
					></div>
				</div>
			{/if}
			<p class="text-sm text-muted">{statusLine}</p>
			{#if a.error}
				<p class="error-box" role="alert">
					{a.error.message}{a.error.retryAt ? ` Will try again at ${clock(a.error.retryAt)}.` : ''}
				</p>
			{/if}
			{#if form?.syncError}<p class="error-box" role="alert">{form.syncError}</p>{/if}
			{#if a.removedCount}
				<form
					method="POST"
					action="?/readd"
					use:enhance={() =>
						async ({ update }) =>
							update({ reset: false })}
					class="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm text-muted"
				>
					<span>
						{`${plural(a.removedCount, 'album', 'albums')} you removed ${a.removedCount === 1 ? "isn't" : "aren't"} re-added.`}
					</span>
					<button class="btn btn-sm">Re-add {a.removedCount === 1 ? 'it' : 'them'}</button>
				</form>
			{/if}
			{#if form?.readded !== undefined}
				<p class="ok-box" role="status">{`Brought back ${plural(form.readded, 'album', 'albums')}.`}</p>
			{/if}
		</section>

		<section class="card p-4 sm:p-5">
			<h2 class="mb-3 font-semibold">Settings</h2>
			<form
				method="POST"
				action="?/save"
				use:enhance={() =>
					async ({ update }) =>
						update({ reset: false })}
				class="space-y-4"
			>
				<div>
					<label class="label" for="save-category">Put albums in</label>
					<select class="input" id="save-category" name="category" bind:value={savePick}>
						{#each data.lists as l (l.id)}
							<option value={String(l.id)}>{l.icon} {l.name}{l.own ? '' : ` · ${l.ownerName}'s list`}</option>
						{/each}
						{#if a.categoryId === null || !data.lists.some((l) => l.id === a.categoryId)}
							<option value={String(a.categoryId ?? '')} disabled>(no list)</option>
						{/if}
					</select>
					{#if saveWarning}<p class="mt-2 text-sm text-amber-700 dark:text-amber-300">{saveWarning}</p>{/if}
					<p class="hint">Albums already in a list stay where they are.</p>
				</div>
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label class="label" for="syncEvery">Sync</label>
						<select class="input" id="syncEvery" name="syncEvery" value={a.syncEvery}>
							<option value="hourly">Every hour</option>
							<option value="daily">Once a day</option>
						</select>
					</div>
					<div>
						<label class="label" for="journalMode">Listening in the Journal</label>
						<select class="input" id="journalMode" name="journalMode" value={a.journalMode}>
							<option value="group">Grouped by day</option>
							<option value="hide">Hidden</option>
							<option value="all">Every album</option>
						</select>
					</div>
				</div>
				{#if form?.saveError}<p class="error-box" role="alert">{form.saveError}</p>{/if}
				{#if form?.saved}<p class="ok-box" role="status">Saved.</p>{/if}
				<button class="btn">Save</button>
			</form>
		</section>

		<section class="card space-y-4 p-4 sm:p-5">
			<h2 class="font-semibold">Stop or start over</h2>
			<form
				method="POST"
				action="?/disconnect"
				use:enhance={({ cancel }) => {
					if (!confirm(`Stop syncing ${a.username}? Everything imported so far stays.`)) cancel();
					return async ({ update }) => update();
				}}
				class="flex flex-wrap items-center gap-3"
			>
				<button class="btn">Stop syncing</button>
				<span class="text-sm text-muted">Forgets the username and keeps everything imported.</span>
			</form>
			<div class="border-t border-border pt-4">{@render deleteImported()}</div>
		</section>
	{/if}
</div>
