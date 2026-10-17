<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import IconPicker from '$lib/components/IconPicker.svelte';
	import { FIELD_TYPES } from '$lib/fields';
	import { PROVIDER_LABELS, categoryColor } from '$lib/kinds';
	import { RELEASE_KINDS } from '$lib/calendar';
	import type { FieldScope, FieldType, StatusGroup } from '$lib/types';

	let { data, form } = $props();
	const c = $derived(data.category);
	/** Someone the list is shared with: they only get their own choices for it */
	const member = $derived(c.access !== 'owner');

	// Everything on this page is one form with one Save button. Statuses, sources and fields are
	// kept here until then, and reset whenever the saved data changes.
	interface FieldDraft {
		uid: string;
		id: number | null;
		scope: FieldScope;
		type: FieldType;
		label: string;
		unit: string;
		options: string;
		showOnCard: boolean;
		removed: boolean;
	}
	const draftsFrom = (rows: typeof data.fieldRows): FieldDraft[] =>
		rows.map((f) => ({
			uid: `f${f.id}`,
			id: f.id,
			scope: f.scope,
			type: f.type,
			label: f.label,
			unit: f.unit ?? '',
			options: (f.options ?? []).join(', '),
			showOnCard: f.showOnCard,
			removed: false
		}));

	// svelte-ignore state_referenced_locally
	let statuses = $state(data.category.statuses.map((s) => ({ ...s })));
	// The name as typed, so the icon picker can suggest matching icons
	// svelte-ignore state_referenced_locally
	let nameDraft = $state(data.category.name);
	// Ticked sources (search kinds and logging extras share the providerKinds field)
	// svelte-ignore state_referenced_locally
	let picked = $state<string[]>([...data.category.providerKinds]);
	// svelte-ignore state_referenced_locally
	let fields = $state<FieldDraft[]>(draftsFrom(data.fieldRows));
	// Bound, not plain checked={…}: a plain attribute is re-applied whenever anything else on the
	// page changes (adding a field, say), which would quietly undo the user's click
	// svelte-ignore state_referenced_locally
	let color = $state(data.category.color);
	// svelte-ignore state_referenced_locally
	let showUpNext = $state(data.category.showUpNext);
	// svelte-ignore state_referenced_locally
	let showInCalendar = $state(data.category.showInCalendar);
	// Who the list is shared with: person id → none, view or edit
	const rolesFrom = (people: typeof data.people) =>
		Object.fromEntries(people.map((p) => [p.id, p.role as string]));
	// svelte-ignore state_referenced_locally
	let shareRoles = $state<Record<number, string>>(rolesFrom(data.people));
	/** The list holds shows, movies or games, so its releases can go in the Calendar */
	const holdsReleases = $derived(picked.some((k) => RELEASE_KINDS.includes(k)));
	$effect(() => {
		statuses = data.category.statuses.map((s) => ({ ...s }));
		nameDraft = data.category.name;
		picked = [...data.category.providerKinds];
		fields = draftsFrom(data.fieldRows);
		color = data.category.color;
		showUpNext = data.category.showUpNext;
		showInCalendar = data.category.showInCalendar;
		shareRoles = rolesFrom(data.people);
	});

	// Extras only make sense for some lists (setlists for music artists); keep any that are on
	const extras = $derived(data.logSources.filter((s) => s.forKinds.some((k) => picked.includes(k))));
	// An extra can't stay on once the kind it belongs to is unticked
	$effect(() => {
		const stale = data.logSources.filter((s) => picked.includes(s.key) && !extras.includes(s));
		if (stale.length) picked = picked.filter((k) => !stale.some((s) => s.key === k));
	});
	// "Wishlist" or "Planning or Watching next": the statuses that put an item in Up next
	const plannedLabels = $derived.by(() => {
		const names = statuses
			.filter((s) => s.group === 'planned' && s.label.trim())
			.map((s) => `“${s.label.trim()}”`);
		return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
	});
	const GROUPS: { value: StatusGroup; label: string }[] = [
		{ value: 'planned', label: 'Planned (wishlist, to-do)' },
		{ value: 'active', label: 'Active (in progress, owned)' },
		{ value: 'done', label: 'Done (finished, tried)' },
		{ value: 'dropped', label: 'Dropped' }
	];
	const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;
	const hasChoices = (t: FieldType) => t === 'select' || t === 'multiselect';
	const saved = $derived(page.url.searchParams.get('saved') === '1');

	// --- Fields ---------------------------------------------------------------------------
	/** Swap with the nearest field of the same kind (item or log) above or below. */
	function moveField(f: FieldDraft, dir: -1 | 1) {
		const i = fields.indexOf(f);
		let j = i + dir;
		while (j >= 0 && j < fields.length && fields[j].scope !== f.scope) j += dir;
		if (j < 0 || j >= fields.length) return;
		[fields[i], fields[j]] = [fields[j], fields[i]];
		changed();
	}

	let newCount = 0;
	let adding = $state({
		label: '',
		type: 'text' as FieldType,
		scope: 'item' as FieldScope,
		options: '',
		unit: '',
		showOnCard: false
	});
	let addError = $state('');
	let justAdded = $state('');

	function addField() {
		const label = adding.label.trim();
		addError = '';
		if (!label) {
			addError = 'Give the field a name.';
			return;
		}
		if (hasChoices(adding.type) && !adding.options.split(',').some((o) => o.trim())) {
			addError = 'List the choices, separated by commas.';
			return;
		}
		fields.push({ uid: `new${++newCount}`, id: null, removed: false, ...adding, label });
		justAdded = label;
		adding = { label: '', type: 'text', scope: adding.scope, options: '', unit: '', showOnCard: false };
		changed();
	}

	const fieldsJson = $derived(
		JSON.stringify(
			fields.map(({ id, scope, type, label, unit, options, showOnCard, removed }) => ({
				id,
				scope,
				type,
				label,
				unit,
				options,
				showOnCard,
				removed
			}))
		)
	);

	// --- Unsaved changes ------------------------------------------------------------------
	let formEl = $state<HTMLFormElement>();
	let baseline = '';
	let dirty = $state(false);
	let saving = $state(false);
	const snapshot = () =>
		formEl ? JSON.stringify([...new FormData(formEl)].map(([k, v]) => [k, String(v)])) : '';

	/** Compares the form with what was last saved (after the DOM has caught up). */
	async function changed() {
		await tick();
		dirty = snapshot() !== baseline;
	}
	$effect(() => {
		void data.category;
		void data.fieldRows;
		void data.people;
		tick().then(() => {
			baseline = snapshot();
			dirty = false;
			justAdded = '';
		});
	});

	beforeNavigate((nav) => {
		if (!dirty || saving) return;
		if (nav.willUnload)
			nav.cancel(); // the browser asks "Leave site?"
		else if (!confirm('You have unsaved changes. Leave without saving them?')) nav.cancel();
	});

	/** For the delete card: "The person" or "The 3 people" the list is shared with */
	const sharedPeople = (n: number) => (n === 1 ? 'The person' : `The ${n} people`);

	// --- Someone the list is shared with: only their own choices ------------------------------
	let savingMine = $state(false);
	const title = $derived(member ? `Your settings for ${c.name}` : `Edit ${c.name}`);
</script>

<svelte:head><title>{title} · The Whatever Tracker</title></svelte:head>

{#if member}
	{@render memberSettings()}
{:else}
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
					Your list is ready. Add the fields you want to track for each entry below, then press Save.
				</p>
			{/if}
		</div>

		{#if saved && !dirty}<p class="ok-box">Saved.</p>{/if}

		<form
			method="POST"
			action="?/save"
			class="space-y-8"
			bind:this={formEl}
			oninput={changed}
			onchange={changed}
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update({ reset: false });
					saving = false;
					changed();
				};
			}}
		>
			<section class="card space-y-5 p-4 sm:p-5">
				<h2 class="font-semibold">Basics</h2>
				<div class="flex gap-3">
					<div class="w-20" onclick={changed} role="presentation">
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
								<input type="radio" name="color" value={name} bind:group={color} class="peer sr-only" />
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
								<select
									class="input w-auto flex-1 sm:flex-none"
									bind:value={s.group}
									aria-label="Status group"
								>
									{#each GROUPS as g (g.value)}<option value={g.value}>{g.label}</option>{/each}
								</select>
								<button
									type="button"
									class="btn btn-ghost btn-icon"
									disabled={statuses.length <= 1}
									onclick={() => {
										statuses.splice(i, 1);
										changed();
									}}
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
						onclick={() => {
							statuses.push({ key: '', label: '', group: 'active' });
							changed();
						}}
					>
						<Icon name="plus" size={14} /> Add status
					</button>
					<input
						type="hidden"
						name="statuses_json"
						value={JSON.stringify(statuses.filter((s) => s.label.trim()))}
					/>
				</fieldset>

				<label class="flex items-start gap-3 text-sm">
					<input
						type="checkbox"
						name="showUpNext"
						bind:checked={showUpNext}
						class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
					/>
					<span>
						<span class="font-medium">Show in Up next on the home page</span>
						<span class="block text-xs text-muted">
							{plannedLabels
								? `Items marked ${plannedLabels} appear there.`
								: 'Items in a planned status appear there.'} Turn it off for long wish lists you don't want on the
							home page. They're still in the list itself.
						</span>
					</span>
				</label>
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
							Nothing ticked: you fill in the details yourself. That's right for things like whiskey, cheese
							or cats.
						{/if}
					</p>
				</fieldset>

				{#if holdsReleases}
					<input type="hidden" name="calendar_setting" value="1" />
					<label class="flex items-start gap-3 text-sm">
						<input
							type="checkbox"
							name="showInCalendar"
							bind:checked={showInCalendar}
							class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
						/>
						<span>
							<span class="font-medium">Show releases in the Calendar</span>
							<span class="block text-xs text-muted">
								New episodes, movie and game release dates for what's in this list. Also on the
								<a class="text-accent underline" href="/calendar">Calendar</a> under Lists.
							</span>
						</span>
					</label>
				{/if}

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
			</section>

			<!-- Fields -->
			<section class="card space-y-4 p-4 sm:p-5">
				<div>
					<h2 class="font-semibold">Fields</h2>
					<p class="text-sm text-muted">
						<strong>Item fields</strong> describe the thing (distillery, vintage). <strong>Log fields</strong> are
						filled in each time (tasting notes, who won).
					</p>
				</div>

				{#each ['item', 'log'] as const as scope (scope)}
					{@const list = fields.filter((f) => f.scope === scope)}
					<div>
						<h3 class="section-title mb-2">{scope === 'item' ? 'Item fields' : 'Log fields'}</h3>
						{#if list.length === 0}
							<p class="text-sm text-muted">None yet.</p>
						{:else}
							<ul class="divide-y divide-border rounded-xl border border-border">
								{#each list as f, i (f.uid)}
									<li class="p-3">
										{#if f.removed}
											<div class="flex items-center gap-2 text-sm">
												<span class="min-w-0 flex-1 truncate text-muted line-through">{f.label}</span>
												<span class="text-xs text-danger">Removed when you save</span>
												<button
													type="button"
													class="btn btn-ghost btn-sm"
													onclick={() => {
														f.removed = false;
														changed();
													}}>Undo</button
												>
											</div>
										{:else}
											<details open={f.id === null && f.label === justAdded}>
												<summary class="flex cursor-pointer list-none items-center gap-2">
													<span class="min-w-0 flex-1 truncate font-medium"
														>{f.label || 'Untitled field'}</span
													>
													{#if f.id === null}<span class="badge">new</span>{/if}
													<span class="badge">{typeLabel(f.type)}</span>
													{#if f.showOnCard}<span class="badge">on card</span>{/if}
													<Icon name="chevron-down" size={16} class="text-muted" />
												</summary>
												<div class="mt-3 grid gap-3 sm:grid-cols-2">
													<div>
														<label class="label" for="fl-{f.uid}">Name</label>
														<input class="input" id="fl-{f.uid}" bind:value={f.label} maxlength="60" />
													</div>
													<div>
														<label class="label" for="fu-{f.uid}">Unit</label>
														<input
															class="input"
															id="fu-{f.uid}"
															bind:value={f.unit}
															maxlength="20"
															placeholder="%, yrs, min…"
														/>
													</div>
													{#if hasChoices(f.type)}
														<div class="sm:col-span-2">
															<label class="label" for="fo-{f.uid}">Choices</label>
															<textarea class="input" id="fo-{f.uid}" rows="2" bind:value={f.options}
															></textarea>
															<p class="hint">Separated by commas.</p>
														</div>
													{/if}
													<label class="flex items-center gap-2 text-sm sm:col-span-2">
														<input
															type="checkbox"
															bind:checked={f.showOnCard}
															class="h-4 w-4 accent-[var(--accent)]"
														/>
														Show on cards in the list view
													</label>
													<div class="flex flex-wrap gap-2 sm:col-span-2">
														<button
															type="button"
															class="btn btn-sm"
															disabled={i === 0}
															onclick={() => moveField(f, -1)}
														>
															Move up
														</button>
														<button
															type="button"
															class="btn btn-sm"
															disabled={i === list.length - 1}
															onclick={() => moveField(f, 1)}
														>
															Move down
														</button>
														<button
															type="button"
															class="btn btn-ghost btn-sm text-danger"
															onclick={() => {
																if (f.id === null) fields.splice(fields.indexOf(f), 1);
																else f.removed = true;
																changed();
															}}
														>
															Remove
														</button>
													</div>
													{#if f.id !== null}
														<p class="text-xs text-muted sm:col-span-2">
															Removing a field keeps what's already been entered; adding it back with the same
															name brings it back.
														</p>
													{/if}
												</div>
											</details>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}

				<!-- Not submitted directly: "Add field" puts it in the list above, saved with everything else -->
				<div class="space-y-3 rounded-xl border border-dashed border-border p-3">
					<h3 class="text-sm font-medium">Add a field</h3>
					<div class="grid gap-3 sm:grid-cols-3">
						<input
							class="input sm:col-span-1"
							bind:value={adding.label}
							placeholder="Field name"
							maxlength="60"
							aria-label="New field name"
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									addField();
								}
							}}
						/>
						<select class="input" bind:value={adding.type} aria-label="New field type">
							{#each FIELD_TYPES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
						</select>
						<select class="input" bind:value={adding.scope} aria-label="New field applies to">
							<option value="item">Item field</option>
							<option value="log">Log field</option>
						</select>
					</div>
					{#if hasChoices(adding.type)}
						<input
							class="input"
							bind:value={adding.options}
							placeholder="Choices, separated by commas"
							aria-label="New field choices"
						/>
					{/if}
					{#if adding.type === 'number'}
						<input
							class="input sm:w-40"
							bind:value={adding.unit}
							placeholder="Unit (optional)"
							aria-label="Unit"
						/>
					{/if}
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={adding.showOnCard} class="h-4 w-4 accent-[var(--accent)]" /> Show
						on cards
					</label>
					{#if addError}<p class="error-box">{addError}</p>{/if}
					<div class="flex flex-wrap items-center gap-3">
						<button type="button" class="btn btn-sm" onclick={addField}>
							<Icon name="plus" size={14} /> Add field
						</button>
						{#if justAdded && dirty}
							<span class="text-sm text-muted">Added “{justAdded}”. Press Save settings to keep it.</span>
						{/if}
					</div>
				</div>
				<input type="hidden" name="fields_json" value={fieldsJson} />
			</section>

			<!-- Sharing with the rest of the household -->
			<section class="card space-y-4 p-4 sm:p-5">
				<div>
					<h2 class="font-semibold">Sharing</h2>
					<p class="mt-1 text-sm text-muted">
						People you share with see this list's items, fields and photos. Each keeps their own status,
						rating, favorites, notes, logs and episodes.
					</p>
				</div>
				{#if data.people.length}
					<ul class="divide-y divide-border rounded-xl border border-border">
						{#each data.people as p (p.id)}
							<li class="flex items-center gap-3 p-3">
								<label class="min-w-0 flex-1" for="share-{p.id}">
									<span class="block truncate text-sm font-medium">{p.displayName}</span>
									<span class="block truncate text-xs text-muted">@{p.username}</span>
								</label>
								<select
									class="input w-auto"
									id="share-{p.id}"
									name="share_{p.id}"
									bind:value={shareRoles[p.id]}
								>
									<option value="none">Not shared</option>
									<option value="view">Can view</option>
									<option value="edit">Can edit</option>
								</select>
							</li>
						{/each}
					</ul>
					<p class="hint">
						Can edit: add, change and remove items. Can view: see the list and keep their own progress.
					</p>
				{:else}
					<p class="text-sm text-muted">
						Nobody else has an account here yet.
						{#if data.user.isAdmin}
							Add people under <a class="text-accent underline" href="/admin/users">Household accounts</a>.
						{:else}
							Ask whoever runs this tracker to add an account for them.
						{/if}
					</p>
				{/if}
			</section>

			<!-- One Save for the whole page, always in reach -->
			<div class="sticky bottom-20 z-10 md:bottom-4">
				<div class="card flex flex-wrap items-center gap-3 p-3 shadow-lg">
					<button class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
					{#if form?.message}
						<p class="text-sm text-danger" role="alert">{form.message}</p>
					{:else if dirty}
						<p class="text-sm text-muted">You have unsaved changes.</p>
					{:else if saved}
						<p class="text-sm text-emerald-700 dark:text-emerald-400">All changes saved.</p>
					{/if}
				</div>
			</div>
		</form>

		<!-- Danger zone -->
		<section class="card border-danger/40 p-4 sm:p-5">
			<h2 class="font-semibold text-danger">Delete this list</h2>
			<p class="mb-3 text-sm text-muted">
				Deletes {c.name} and its {data.itemCount}
				{data.itemCount === 1 ? 'item' : 'items'}, logs and photos.
				{#if c.sharedWith > 0}
					{sharedPeople(c.sharedWith)} it's shared with {c.sharedWith === 1 ? 'loses' : 'lose'} it too.
				{/if}
				This cannot be undone.
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
{/if}

<!-- A list someone shared with the viewer: who it's from, their own choices, and leaving it -->
{#snippet memberSettings()}
	<div class="mx-auto max-w-3xl space-y-8">
		<div>
			<a href="/c/{c.slug}" class="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
				<Icon name="chevron-left" size={16} />
				{c.icon}
				{c.name}
			</a>
			<h1 class="text-2xl font-semibold tracking-tight">List settings</h1>
		</div>

		<section class="card flex items-center gap-3 p-4 sm:p-5">
			<span
				class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl"
				style="background: color-mix(in srgb, {categoryColor(c.color)} 16%, transparent)"
				aria-hidden="true">{c.icon}</span
			>
			<div class="min-w-0">
				<p class="truncate font-semibold">{c.name}</p>
				<p class="text-sm text-muted">Shared with you by {c.ownerName}</p>
				<p class="text-sm text-muted">
					{c.access === 'edit' ? 'You can edit its items' : 'You can view it and keep your own progress'}
				</p>
			</div>
		</section>

		<form
			method="POST"
			action="?/mine"
			class="card space-y-4 p-4 sm:p-5"
			use:enhance={() => {
				savingMine = true;
				return async ({ update }) => {
					await update({ reset: false });
					savingMine = false;
				};
			}}
		>
			<div>
				<h2 class="font-semibold">Just for you</h2>
				<p class="mt-1 text-sm text-muted">These only change what you see.</p>
			</div>
			<label class="flex items-start gap-3 text-sm">
				<input
					type="checkbox"
					name="showUpNext"
					bind:checked={showUpNext}
					class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
				/>
				<span>
					<span class="font-medium">Show in Up next on the home page</span>
					<span class="block text-xs text-muted">
						{plannedLabels
							? `Items you mark ${plannedLabels} appear there.`
							: 'Items in a planned status appear there.'}
					</span>
				</span>
			</label>
			{#if holdsReleases}
				<input type="hidden" name="calendar_setting" value="1" />
				<label class="flex items-start gap-3 text-sm">
					<input
						type="checkbox"
						name="showInCalendar"
						bind:checked={showInCalendar}
						class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
					/>
					<span>
						<span class="font-medium">Show releases in the Calendar</span>
						<span class="block text-xs text-muted">
							New episodes, movie and game release dates for what's in this list.
						</span>
					</span>
				</label>
			{/if}
			<div class="flex flex-wrap items-center gap-3">
				<button class="btn btn-primary" disabled={savingMine}>{savingMine ? 'Saving…' : 'Save'}</button>
				{#if form?.mineSaved}<p class="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>{/if}
			</div>
		</form>

		<section class="card border-danger/40 p-4 sm:p-5">
			<h2 class="font-semibold text-danger">Leave this list</h2>
			<p class="mb-3 text-sm text-muted">
				You'll stop seeing it. Your ratings and logs are kept, and come back if {c.ownerName} shares it again.
			</p>
			{#if form?.leaveMessage}<p class="error-box mb-3">{form.leaveMessage}</p>{/if}
			<form
				method="POST"
				action="?/leave"
				onsubmit={(e) => {
					if (!confirm(`Leave ${c.name}?`)) e.preventDefault();
				}}
			>
				<button class="btn btn-danger">Leave list</button>
			</form>
		</section>
	</div>
{/snippet}

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
