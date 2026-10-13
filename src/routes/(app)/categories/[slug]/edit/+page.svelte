<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import IconPicker from '$lib/components/IconPicker.svelte';
	import { FIELD_TYPES } from '$lib/fields';
	import { PROVIDER_LABELS } from '$lib/kinds';
	import type { StatusGroup } from '$lib/types';

	let { data, form } = $props();
	const c = $derived(data.category);

	// Editable status list (serialized into a hidden input on save); reset whenever the page data changes
	// svelte-ignore state_referenced_locally
	let statuses = $state(data.category.statuses.map((s) => ({ ...s })));
	// The name as typed, so the icon picker can suggest matching icons
	// svelte-ignore state_referenced_locally
	let nameDraft = $state(data.category.name);
	// Ticked sources (search kinds and logging extras share the providerKinds field)
	// svelte-ignore state_referenced_locally
	let picked = $state<string[]>([...data.category.providerKinds]);
	$effect(() => {
		statuses = data.category.statuses.map((s) => ({ ...s }));
		nameDraft = data.category.name;
		picked = [...data.category.providerKinds];
	});
	// Extras only make sense for some lists (setlists for music artists); keep any that are on
	const extras = $derived(data.logSources.filter((s) => s.forKinds.some((k) => picked.includes(k))));
	// An extra can't stay on once the kind it belongs to is unticked
	$effect(() => {
		const stale = data.logSources.filter((s) => picked.includes(s.key) && !extras.includes(s));
		if (stale.length) picked = picked.filter((k) => !stale.some((s) => s.key === k));
	});
	const GROUPS: { value: StatusGroup; label: string }[] = [
		{ value: 'planned', label: 'Planned (wishlist, to-do)' },
		{ value: 'active', label: 'Active (in progress, owned)' },
		{ value: 'done', label: 'Done (finished, tried)' },
		{ value: 'dropped', label: 'Dropped' }
	];

	let newType = $state('text');
	const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;
	const saved = $derived(page.url.searchParams.get('saved') === '1');
</script>

<svelte:head><title>Edit {c.name} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-8">
	<div>
		<a href="/c/{c.slug}" class="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
			<Icon name="chevron-left" size={16} />
			{c.icon}
			{c.name}
		</a>
		<h1 class="text-2xl font-semibold tracking-tight">List settings</h1>
		{#if data.isNew}
			<p class="mt-1 text-sm text-muted">
				Your list is ready. Add the fields you want to track for each entry below.
			</p>
		{/if}
	</div>

	{#if saved}<p class="ok-box">Saved.</p>{/if}
	{#if form?.message}<p class="error-box">{form.message}</p>{/if}

	<!-- Basics and lookups save together -->
	<form method="POST" action="?/save" class="space-y-8">
		<section class="card space-y-5 p-4 sm:p-5">
			<h2 class="font-semibold">Basics</h2>
			<div class="flex gap-3">
				<div class="w-20">
					<label class="label" for="icon">Icon</label>
					{#key c.id}
						<IconPicker name="icon" value={c.icon} hint={nameDraft} />
					{/key}
				</div>
				<div class="flex-1">
					<label class="label" for="name">Name</label>
					<input class="input" id="name" name="name" bind:value={nameDraft} required maxlength="60" />
				</div>
			</div>

			<fieldset>
				<legend class="label">Color</legend>
				<div class="flex flex-wrap gap-2">
					{#each data.colors as [name, hex] (name)}
						<label class="cursor-pointer">
							<input type="radio" name="color" value={name} checked={c.color === name} class="peer sr-only" />
							<span
								class="block h-8 w-8 rounded-full ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-fg peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
								style="background: {hex}"
								title={name}
							></span>
						</label>
					{/each}
				</div>
			</fieldset>

			<fieldset>
				<legend class="label">Statuses</legend>
				<p class="hint mb-3 mt-0">
					The group decides what counts as “up next” and what a new log marks as done.
				</p>
				<div class="space-y-2">
					{#each statuses as s, i (i)}
						<div class="flex flex-wrap gap-2 sm:flex-nowrap">
							<input
								class="input min-w-0 flex-1"
								bind:value={s.label}
								aria-label="Status name"
								maxlength="60"
							/>
							<select class="input w-auto flex-1 sm:flex-none" bind:value={s.group} aria-label="Status group">
								{#each GROUPS as g (g.value)}<option value={g.value}>{g.label}</option>{/each}
							</select>
							<button
								type="button"
								class="btn btn-ghost btn-icon"
								disabled={statuses.length <= 1}
								onclick={() => statuses.splice(i, 1)}
								aria-label="Remove status {s.label}"
							>
								<Icon name="x" size={18} />
							</button>
						</div>
					{/each}
				</div>
				<button
					type="button"
					class="btn btn-sm mt-2"
					onclick={() => statuses.push({ key: '', label: '', group: 'active' })}
				>
					<Icon name="plus" size={14} /> Add status
				</button>
				<input
					type="hidden"
					name="statuses_json"
					value={JSON.stringify(statuses.filter((s) => s.label.trim()))}
				/>
			</fieldset>
		</section>

		<!-- What the list holds decides where new entries are looked up -->
		<section class="card space-y-4 p-4 sm:p-5">
			<div>
				<h2 class="font-semibold">Fill in details automatically</h2>
				<p class="mt-1 text-sm text-muted">
					Pick what {nameDraft || 'this list'} holds. When you add something, it's looked up online so the picture
					and details fill themselves in, and the search bar suggests matches for this list.
				</p>
			</div>

			<fieldset>
				<legend class="sr-only">What this list holds</legend>
				<div class="grid gap-2 sm:grid-cols-2">
					{#each data.kinds as k (k.key)}
						{@render choice(k.key, k.icon, k.label, k.provider, k.gives, k.enabled)}
					{/each}
				</div>
				<p class="hint">
					{#if picked.some((k) => data.kinds.some((x) => x.key === k))}
						Tick more than one for a mixed list, like movies and TV shows together.
					{:else}
						Nothing ticked: you fill in the details yourself. That's right for things like whiskey, cheese or
						cats.
					{/if}
				</p>
			</fieldset>

			{#if extras.length}
				<fieldset>
					<legend class="section-title mb-2">Extras</legend>
					<div class="grid gap-2 sm:grid-cols-2">
						{#each extras as s (s.key)}
							{@render choice(s.key, '🎟️', s.label, s.provider, s.gives, s.enabled)}
						{/each}
					</div>
				</fieldset>
			{/if}

			<button class="btn btn-primary">Save settings</button>
		</section>
	</form>

	<!-- Fields -->
	<section class="card space-y-4 p-4 sm:p-5">
		<div>
			<h2 class="font-semibold">Fields</h2>
			<p class="text-sm text-muted">
				<strong>Item fields</strong> describe the thing (distillery, vintage). <strong>Log fields</strong> are filled
				in each time (tasting notes, who won).
			</p>
		</div>
		{#if form?.fieldMessage}<p class="error-box">{form.fieldMessage}</p>{/if}

		{#each ['item', 'log'] as scope (scope)}
			{@const list = data.fieldRows.filter((f) => f.scope === scope)}
			<div>
				<h3 class="section-title mb-2">{scope === 'item' ? 'Item fields' : 'Log fields'}</h3>
				{#if list.length === 0}
					<p class="text-sm text-muted">None yet.</p>
				{:else}
					<ul class="divide-y divide-border rounded-xl border border-border">
						{#each list as f (f.id)}
							<li class="p-3">
								<details>
									<summary class="flex cursor-pointer list-none items-center gap-2">
										<span class="min-w-0 flex-1 truncate font-medium">{f.label}</span>
										<span class="badge">{typeLabel(f.type)}</span>
										{#if f.showOnCard}<span class="badge">on card</span>{/if}
										<Icon name="chevron-down" size={16} class="text-muted" />
									</summary>
									<form
										method="POST"
										action="?/updateField"
										use:enhance={() =>
											async ({ update }) =>
												update({ reset: false })}
										class="mt-3 grid gap-3 sm:grid-cols-2"
									>
										<input type="hidden" name="id" value={f.id} />
										<div>
											<label class="label" for="fl-{f.id}">Name</label>
											<input class="input" id="fl-{f.id}" name="label" value={f.label} maxlength="60" />
										</div>
										<div>
											<label class="label" for="fu-{f.id}">Unit</label>
											<input
												class="input"
												id="fu-{f.id}"
												name="unit"
												value={f.unit ?? ''}
												maxlength="20"
												placeholder="%, yrs, min…"
											/>
										</div>
										{#if f.type === 'select' || f.type === 'multiselect'}
											<div class="sm:col-span-2">
												<label class="label" for="fo-{f.id}">Choices</label>
												<textarea class="input" id="fo-{f.id}" name="options" rows="2"
													>{f.options.join(', ')}</textarea
												>
											</div>
										{/if}
										<label class="flex items-center gap-2 text-sm sm:col-span-2">
											<input
												type="checkbox"
												name="showOnCard"
												checked={f.showOnCard}
												class="h-4 w-4 accent-[var(--accent)]"
											/>
											Show on cards in the list view
										</label>
										<div class="flex flex-wrap gap-2 sm:col-span-2">
											<button class="btn btn-primary btn-sm">Save field</button>
											<button class="btn btn-sm" formaction="?/moveField" name="dir" value="up"
												>Move up</button
											>
											<button class="btn btn-sm" formaction="?/moveField" name="dir" value="down"
												>Move down</button
											>
											<button
												class="btn btn-ghost btn-sm text-danger"
												formaction="?/deleteField"
												onclick={(e) => {
													if (
														!confirm(
															`Remove the “${f.label}” field? Values already entered are kept and come back if you re-add it.`
														)
													)
														e.preventDefault();
												}}
											>
												Remove
											</button>
										</div>
										{#if form?.fieldSaved === f.id}<p class="text-sm text-emerald-600 sm:col-span-2">
												Saved.
											</p>{/if}
									</form>
								</details>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/each}

		<form
			method="POST"
			action="?/addField"
			use:enhance
			class="space-y-3 rounded-xl border border-dashed border-border p-3"
		>
			<h3 class="text-sm font-medium">Add a field</h3>
			<div class="grid gap-3 sm:grid-cols-3">
				<input
					class="input sm:col-span-1"
					name="label"
					placeholder="Field name"
					required
					maxlength="60"
					aria-label="Field name"
				/>
				<select class="input" name="type" bind:value={newType} aria-label="Field type">
					{#each FIELD_TYPES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
				</select>
				<select class="input" name="scope" aria-label="Field applies to">
					<option value="item">Item field</option>
					<option value="log">Log field</option>
				</select>
			</div>
			{#if newType === 'select' || newType === 'multiselect'}
				<input class="input" name="options" placeholder="Choices, separated by commas" aria-label="Choices" />
			{/if}
			{#if newType === 'number'}
				<input class="input sm:w-40" name="unit" placeholder="Unit (optional)" aria-label="Unit" />
			{/if}
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="showOnCard" class="h-4 w-4 accent-[var(--accent)]" /> Show on cards
			</label>
			<button class="btn btn-primary btn-sm"><Icon name="plus" size={14} /> Add field</button>
		</form>
	</section>

	<!-- Danger zone -->
	<section class="card border-danger/40 p-4 sm:p-5">
		<h2 class="font-semibold text-danger">Delete this list</h2>
		<p class="mb-3 text-sm text-muted">
			Deletes {c.name} and its {data.itemCount}
			{data.itemCount === 1 ? 'item' : 'items'}, logs and photos. This cannot be undone.
		</p>
		{#if form?.deleteMessage}<p class="error-box mb-3">{form.deleteMessage}</p>{/if}
		<form method="POST" action="?/delete" class="flex flex-wrap gap-2">
			<input
				class="input min-w-0 flex-1"
				name="confirm"
				placeholder="Type {c.name} to confirm"
				aria-label="Confirm list name"
			/>
			<button class="btn btn-danger">Delete list</button>
		</form>
	</section>
</div>

{#snippet choice(key: string, icon: string, label: string, provider: string, gives: string, enabled: boolean)}
	<label
		class="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-surface-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
	>
		<input
			type="checkbox"
			name="providerKinds"
			value={key}
			bind:group={picked}
			class="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
		/>
		<span class="text-xl leading-none" aria-hidden="true">{icon}</span>
		<span class="min-w-0 flex-1">
			<span class="block text-sm font-medium">{label}</span>
			<span class="block text-xs text-muted">{gives}</span>
			<span class="mt-1 block text-xs">
				<span class="text-muted">from {PROVIDER_LABELS[provider]}</span>
				{#if !enabled}
					·
					<a class="text-accent underline" href="/settings#integrations">
						{page.data.user?.isAdmin ? `set up ${PROVIDER_LABELS[provider]} first` : 'not set up yet'}
					</a>
				{/if}
			</span>
		</span>
	</label>
{/snippet}
