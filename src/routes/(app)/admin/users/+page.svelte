<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Household · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Household accounts</h1>
		<p class="mt-1 text-sm text-muted">
			Everyone gets their own lists, ratings and photos. Nobody can see anyone else's.
		</p>
	</div>

	{#if form?.message}<p class="error-box">{form.message}</p>{/if}
	{#if form?.created}<p class="ok-box">Created {form.created}. They can sign in now.</p>{/if}
	{#if form?.deleted}<p class="ok-box">Deleted {form.deleted}.</p>{/if}
	{#if form?.reset}<p class="ok-box">Password reset.</p>{/if}

	<ul class="card divide-y divide-border">
		{#each data.users as u (u.id)}
			<li class="p-4">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{u.displayName}</span>
					<span class="text-sm text-muted">@{u.username}</span>
					{#if u.isAdmin}<span class="badge">admin</span>{/if}
					{#if u.id === data.user.id}<span class="badge">you</span>{/if}
					<span class="ml-auto text-xs text-muted">{u.items} items</span>
				</div>
				<details class="mt-2">
					<summary class="cursor-pointer text-sm text-accent">Manage</summary>
					<div class="mt-3 space-y-3">
						<form method="POST" action="?/reset" use:enhance class="flex flex-wrap gap-2">
							<input type="hidden" name="id" value={u.id} />
							<input
								class="input min-w-0 flex-1"
								type="password"
								name="password"
								placeholder="New password"
								minlength="8"
								autocomplete="new-password"
								required
								aria-label="New password for {u.username}"
							/>
							<button class="btn">Reset password</button>
						</form>
						<form method="POST" action="?/toggleAdmin" use:enhance>
							<input type="hidden" name="id" value={u.id} />
							<button class="btn btn-sm">{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
						</form>
						{#if u.id !== data.user.id}
							<form method="POST" action="?/delete" use:enhance class="flex flex-wrap gap-2">
								<input type="hidden" name="id" value={u.id} />
								<input
									class="input min-w-0 flex-1"
									name="confirm"
									placeholder="Type {u.username} to delete"
									aria-label="Confirm deleting {u.username}"
								/>
								<button class="btn btn-danger">Delete account</button>
							</form>
						{/if}
					</div>
				</details>
			</li>
		{/each}
	</ul>

	<section class="card p-4 sm:p-5">
		<h2 class="mb-3 font-semibold">Add someone</h2>
		<form method="POST" action="?/create" use:enhance class="grid gap-3 sm:grid-cols-2">
			<div>
				<label class="label" for="nu-username">Username</label>
				<input
					class="input"
					id="nu-username"
					name="username"
					autocapitalize="none"
					spellcheck="false"
					required
					value={form?.username ?? ''}
				/>
			</div>
			<div>
				<label class="label" for="nu-display">Display name</label>
				<input class="input" id="nu-display" name="displayName" value={form?.displayName ?? ''} />
			</div>
			<div>
				<label class="label" for="nu-password">Starting password</label>
				<input
					class="input"
					id="nu-password"
					name="password"
					type="password"
					minlength="8"
					autocomplete="new-password"
					required
				/>
			</div>
			<label class="flex items-end gap-2 pb-3 text-sm">
				<input type="checkbox" name="isAdmin" class="h-4 w-4 accent-[var(--accent)]" /> Admin (can manage accounts)
			</label>
			<div class="sm:col-span-2"><button class="btn btn-primary">Create account</button></div>
		</form>
	</section>
</div>
