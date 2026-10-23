<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import IntegrationRow from '$lib/components/IntegrationRow.svelte';

	let { data, form } = $props();
	// Spreadsheets only go into the user's own lists (not ones shared with them)
	const ownLists = $derived(data.categories.filter((c) => c.access === 'owner'));

	const lastfm = $derived(data.lastfm.account);

	/** "12 min ago", "3 h ago", "2 d ago" */
	function ago(ms: number) {
		const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
		if (min < 1) return 'just now';
		if (min < 60) return `${min} min ago`;
		if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
		return `${Math.round(min / 1440)} d ago`;
	}

	function size(n: number) {
		return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
	}
</script>

<svelte:head><title>Settings · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>

	<section class="card space-y-4 p-4 sm:p-5">
		<h2 class="font-semibold">Profile</h2>
		<p class="text-sm text-muted">
			Signed in as <strong>{data.user.username}</strong>{data.user.isAdmin ? ' (admin)' : ''}.
		</p>
		<form
			method="POST"
			action="?/profile"
			use:enhance={() =>
				async ({ update }) =>
					update({ reset: false })}
			class="flex flex-wrap items-end gap-2"
		>
			<div class="min-w-0 flex-1">
				<label class="label" for="displayName">Display name</label>
				<input
					class="input"
					id="displayName"
					name="displayName"
					value={data.user.displayName}
					maxlength="60"
				/>
			</div>
			<button class="btn">Save</button>
		</form>
		{#if form?.profileMessage}<p class="error-box">{form.profileMessage}</p>{/if}
		{#if form?.profileSaved}<p class="ok-box">Saved.</p>{/if}

		<form
			method="POST"
			action="?/password"
			use:enhance
			class="grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
		>
			<div>
				<label class="label" for="current">Current password</label>
				<input
					class="input"
					id="current"
					name="current"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div>
				<label class="label" for="next">New password</label>
				<input
					class="input"
					id="next"
					name="next"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			<button class="btn">Change password</button>
		</form>
		{#if form?.passwordMessage}<p class="error-box">{form.passwordMessage}</p>{/if}
		{#if form?.passwordSaved}<p class="ok-box">Password changed. Other devices were signed out.</p>{/if}

		<div class="flex flex-wrap gap-2 border-t border-border pt-4">
			{#if data.user.isAdmin}
				<a class="btn" href="/admin/users"><Icon name="shield" size={16} /> Household accounts</a>
			{/if}
			<form method="POST" action="/logout">
				<button class="btn"><Icon name="logout" size={16} /> Sign out</button>
			</form>
		</div>
	</section>

	<section id="integrations" class="card scroll-mt-20 p-4 sm:p-5">
		<h2 class="mb-1 font-semibold">Integrations</h2>
		<p class="mb-2 text-sm text-muted">
			Sources without a key are skipped by search.
			{#if data.user.isAdmin}
				Keys you save here take priority over the ones in the Portainer stack. They're stored in the app's
				database on your NAS (and its backups), and are never shown in full again.
			{:else}
				Only an admin can change keys.
			{/if}
		</p>
		<ul class="divide-y divide-border">
			{#each data.integrations as i (i.id)}
				<IntegrationRow
					integration={i}
					isAdmin={data.user.isAdmin}
					result={form && 'integration' in form && form.integration === i.id ? form : null}
				/>
			{/each}
		</ul>
	</section>

	<section class="card p-4 sm:p-5">
		<h2 class="mb-1 font-semibold">Your last.fm</h2>
		{#if lastfm}
			<p class="mb-3 text-sm text-muted">
				Connected as <strong>{lastfm.username}</strong>{' · '}{lastfm.state === 'importing'
					? `Importing${lastfm.percent !== null ? ` ${lastfm.percent}%` : ''}`
					: lastfm.lastSyncAt
						? `Last synced ${ago(lastfm.lastSyncAt)}`
						: 'Waiting for the first sync'}
			</p>
			<a class="btn" href="/settings/lastfm"><Icon name="music" size={16} /> Manage</a>
		{:else if data.lastfm.ready}
			<p class="mb-3 text-sm text-muted">
				Bring in everything you've listened to on last.fm: every album becomes part of a list, each listening
				day a log in your Journal.
			</p>
			<a class="btn" href="/settings/lastfm"><Icon name="music" size={16} /> Connect last.fm</a>
		{:else}
			<p class="text-sm text-muted">
				Bring in everything you've listened to on last.fm. An admin needs to add a last.fm API key first.
				{#if data.user.isAdmin}
					<a class="text-accent underline" href="#integrations">Add it under Integrations.</a>
				{/if}
			</p>
		{/if}
	</section>

	<section class="card p-4 sm:p-5">
		<h2 class="mb-1 font-semibold">Your data</h2>
		<p class="mb-4 text-sm text-muted">
			Bring in your Yamtrack history, or download everything you've tracked.
		</p>
		<div class="flex flex-wrap gap-2">
			<a class="btn" href="/settings/import"><Icon name="upload" size={16} /> Import from Yamtrack</a>
			<a class="btn" href="/settings/export" data-sveltekit-reload
				><Icon name="download" size={16} /> Export as JSON</a
			>
		</div>
		{#if ownLists.length}
			<div class="mt-4">
				<p class="mb-2 text-sm text-muted">
					Or paste or upload a spreadsheet (like a table of whiskeys or movies) into a list:
				</p>
				<div class="flex flex-wrap gap-2">
					{#each ownLists as c (c.id)}
						<a class="chip" href="/c/{c.slug}/import"><span>{c.icon}</span>{c.name}</a>
					{/each}
				</div>
			</div>
		{/if}
	</section>

	{#if data.user.isAdmin}
		<section class="card p-4 sm:p-5">
			<h2 class="mb-1 font-semibold">Backups</h2>
			<p class="mb-3 text-sm text-muted">
				A snapshot of the database is saved every night to <code class="text-xs">{data.dataDir}/backups</code
				>. Back up the whole data folder (database + photos) with Hyper Backup.
			</p>
			{#if data.backups.length}
				<ul class="text-sm">
					{#each data.backups as b (b.name)}
						<li class="flex justify-between py-1">
							<span class="font-mono text-xs">{b.name}</span><span class="text-muted">{size(b.size)}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted">The first snapshot is taken shortly after startup.</p>
			{/if}
		</section>
	{/if}

	<p class="text-center text-xs text-muted">The Whatever Tracker v{data.version}</p>
</div>
