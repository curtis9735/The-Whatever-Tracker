<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { FIELD_TYPES } from '$lib/fields';
	import {
		buildRows,
		countRows,
		distinctStatusCells,
		guessMapping,
		guessRatingMax,
		guessStatusMap,
		parseRatingCell,
		planNewFields,
		validateMapping,
		withNewFields,
		NEW_FIELD_TYPES,
		type ImportMapping
	} from '$lib/import/sheet';
	import { parseTable } from '$lib/import/table';

	let { data, form } = $props();
	const ctx = $derived(data.ctx);
	const cat = $derived(data.category);
	// Only the user's own lists take a spreadsheet, not ones shared with them
	const ownLists = $derived(data.categories.filter((c) => c.access === 'owner'));

	let text = $state('');
	let mapping = $state<ImportMapping | null>(null);
	/** Rows the user ticked or unticked by hand; the rest follow the defaults */
	let overrides = $state<Record<number, boolean>>({});
	let showAll = $state(false);
	let busy = $state(false);
	let fileError = $state('');

	const table = $derived(parseTable(text));
	const hasData = $derived(table.headers.length > 0 && table.rows.length > 0);
	const newFields = $derived(mapping ? planNewFields(table, mapping, ctx) : []);
	const resolved = $derived(mapping ? withNewFields(mapping, ctx, newFields) : null);
	const rows = $derived(resolved ? buildRows(table, resolved.mapping, resolved.ctx) : []);
	const problem = $derived(mapping ? validateMapping(mapping, table, ctx) : null);

	const isSkipped = (r: { index: number; result: string }) =>
		r.result === 'blank' ||
		(overrides[r.index] !== undefined ? !overrides[r.index] : r.result === 'duplicate');
	const skippedList = $derived(rows.filter(isSkipped).map((r) => r.index));
	const counts = $derived(countRows(rows, new Set(skippedList)));
	const issueCount = $derived(rows.reduce((n, r) => n + (isSkipped(r) ? 0 : r.issues.length), 0));
	const visible = $derived(showAll ? rows : rows.slice(0, 100));

	const col = (j: number) => table.rows.map((r) => r[j] ?? '');
	const statusCol = $derived(mapping ? mapping.targets.indexOf('basic:status') : -1);
	const ratingCol = $derived(mapping ? mapping.targets.indexOf('basic:rating') : -1);
	const statusCells = $derived(statusCol === -1 ? [] : distinctStatusCells(col(statusCol)));
	const guessedMax = $derived(ratingCol === -1 ? 5 : guessRatingMax(col(ratingCol)));
	const hasDateCol = $derived(!!mapping?.targets.includes('log:date'));

	function setText(v: string) {
		text = v;
		overrides = {};
		showAll = false;
		const t = parseTable(v);
		mapping = t.headers.length && t.rows.length ? guessMapping(t, ctx) : null;
	}

	async function onFile(e: Event) {
		fileError = '';
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 8 * 1024 * 1024) {
			fileError = 'That file is larger than 8 MB.';
			return;
		}
		setText(await file.text());
	}

	function setTarget(j: number, value: string) {
		if (!mapping) return;
		const before = mapping.targets[j];
		mapping.targets[j] = value;
		if (value === 'basic:status' || before === 'basic:status') {
			const s = mapping.targets.indexOf('basic:status');
			mapping.statusMap = s === -1 ? {} : guessStatusMap(col(s), ctx.statuses);
		}
		if (value === 'basic:rating') {
			mapping.ratingNotes = col(j).some((v) => (parseRatingCell(v)?.rest ?? '') !== '');
		}
	}

	/** Each destination can be used once (new fields and "skip" any number of times) */
	const taken = (target: string, j: number) =>
		!!mapping && mapping.targets.some((t, k) => k !== j && t === target);

	const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;
	const BASICS = [
		['basic:name', 'Name'],
		['basic:subtitle', 'Subtitle'],
		['basic:notes', 'Notes'],
		['basic:barcode', 'Barcode'],
		['basic:status', 'Status'],
		['basic:rating', 'Rating'],
		['basic:tags', 'Tags'],
		['basic:image', 'Photo link']
	];
	const statusName = (key: string) => ctx.statuses.find((s) => s.key === key)?.label ?? key;
</script>

<svelte:head><title>Import into {cat.name} · The Whatever Tracker</title></svelte:head>

<div class="mx-auto max-w-5xl space-y-6">
	<div>
		<a href="/c/{cat.slug}" class="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
			<Icon name="chevron-left" size={16} />
			{cat.icon}
			{cat.name}
		</a>
		<h1 class="text-2xl font-semibold tracking-tight">Import a spreadsheet into {cat.icon} {cat.name}</h1>
	</div>

	{#if form?.done}
		{@const d = form.done}
		<div class="card space-y-3 p-5">
			<p class="ok-box">Import finished.</p>
			<ul class="text-sm">
				<li><strong>{d.created}</strong> added</li>
				<li><strong>{d.updated}</strong> already in the list, updated</li>
				{#if d.logs}<li><strong>{d.logs}</strong> {d.logs === 1 ? 'log' : 'logs'} added</li>{/if}
				{#if d.newFields.length}<li>New fields: {d.newFields.join(', ')}</li>{/if}
				{#if d.addedChoices}<li>
						<strong>{d.addedChoices}</strong> new choices added to pick-one fields
					</li>{/if}
				{#if d.skipped}<li>{d.skipped} rows left out</li>{/if}
			</ul>
			<div class="flex gap-2">
				<a class="btn btn-primary" href="/c/{cat.slug}">Go to {cat.name}</a>
				<a class="btn" href="/c/{cat.slug}/import" data-sveltekit-reload>Import more</a>
			</div>
		</div>
	{:else}
		<!-- 1. The data -->
		<section class="card space-y-3 p-4 sm:p-5">
			<h2 class="font-semibold">1. Your table</h2>
			{#if !hasData}
				<p class="text-sm text-muted">
					In your spreadsheet, select the cells <strong>including the header row</strong>, copy them, and
					paste here. Or choose a CSV file. Only include the columns you want.
				</p>
				<textarea
					class="input font-mono text-xs"
					rows="8"
					placeholder="Whiskey Name&#9;Cost&#9;Distillery&#10;Accord Stone&#9;$9&#9;…"
					aria-label="Paste your table"
					oninput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}></textarea>
				<div class="flex flex-wrap items-center gap-3">
					<label class="btn btn-sm cursor-pointer">
						<Icon name="upload" size={14} /> Choose a CSV file
						<input
							class="sr-only"
							type="file"
							accept=".csv,.tsv,.txt,text/csv,text/plain"
							onchange={onFile}
						/>
					</label>
					{#if text.trim() && !hasData}
						<span class="text-sm text-muted">Needs a header row and at least one row below it.</span>
					{/if}
				</div>
				{#if fileError}<p class="error-box">{fileError}</p>{/if}
				{#if ownLists.length > 1}
					<div class="flex items-center gap-2 text-sm">
						<label for="into" class="text-muted">Import into</label>
						<select
							id="into"
							class="input min-h-9 w-auto py-0"
							value={cat.slug}
							onchange={(e) => goto(`/c/${(e.currentTarget as HTMLSelectElement).value}/import`)}
						>
							{#each ownLists as c (c.id)}<option value={c.slug}>{c.icon} {c.name}</option>{/each}
						</select>
					</div>
				{/if}
			{:else}
				<p class="text-sm">
					<strong>{table.rows.length}</strong>
					{table.rows.length === 1 ? 'row' : 'rows'} and <strong>{table.headers.length}</strong> columns
					{#if table.truncated}<span class="text-muted"> (only the first 5,000 rows are read)</span>{/if}
				</p>
				<button class="btn btn-sm" onclick={() => setText('')}>Use different data</button>
			{/if}
		</section>

		{#if hasData && mapping}
			<!-- 2. Where each column goes -->
			<section class="card space-y-4 p-4 sm:p-5">
				<div>
					<h2 class="font-semibold">2. Where does each column go?</h2>
					<p class="text-sm text-muted">
						These are guessed from the headers. Change any of them. Choose <strong>Skip</strong> for columns you
						don't want.
					</p>
				</div>

				{#if statusCol !== -1}
					<div class="rounded-xl border border-border p-3">
						<p class="mb-2 text-sm font-medium">
							Status: what does each value in “{table.headers[statusCol]}” mean?
						</p>
						<div class="grid gap-2 sm:grid-cols-2">
							{#each statusCells as k (k)}
								<label class="flex items-center gap-2 text-sm">
									<span
										class="w-28 shrink-0 truncate rounded-lg bg-surface-2 px-2 py-1 text-center"
										title={k || 'blank'}
									>
										{k || '(blank)'}
									</span>
									→
									<select
										class="input min-h-9 py-0"
										bind:value={mapping.statusMap[k]}
										aria-label="Status for {k || 'blank'}"
									>
										{#each ctx.statuses as s (s.key)}<option value={s.key}>{s.label}</option>{/each}
										<option value="">No status</option>
									</select>
								</label>
							{/each}
						</div>
						<p class="hint">Items already in the list keep their status when the cell is blank.</p>
					</div>
				{/if}

				{#if ratingCol !== -1}
					<div class="rounded-xl border border-border p-3">
						<p class="mb-2 text-sm font-medium">Rating: “{table.headers[ratingCol]}”</p>
						<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
							<label class="flex w-full flex-col gap-1 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
								Ratings without a scale are out of
								<select
									class="input min-h-9 w-full py-0 sm:w-auto"
									value={mapping.ratingMax === null ? 'auto' : String(mapping.ratingMax)}
									onchange={(e) => {
										const v = (e.currentTarget as HTMLSelectElement).value;
										if (mapping) mapping.ratingMax = v === 'auto' ? null : Number(v);
									}}
								>
									<option value="auto">Automatic (out of {guessedMax})</option>
									<option value="5">5</option>
									<option value="10">10</option>
									<option value="100">100</option>
								</select>
							</label>
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									bind:checked={mapping.ratingNotes}
									class="h-4 w-4 accent-[var(--accent)]"
								/>
								Text after the rating goes into notes
							</label>
						</div>
						<p class="hint">
							A cell like “2.5/5” or “8 out of 10” keeps its own scale. Everything is converted to a whole
							number out of 10.
						</p>
					</div>
				{/if}

				{#if problem}<p class="error-box">{problem}</p>{/if}

				<!-- The table -->
				<div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
					<table class="w-full border-separate border-spacing-0 text-sm">
						<thead>
							<tr class="align-bottom">
								<th class="sticky left-0 z-10 w-8 border-b border-border bg-surface p-1"></th>
								<th class="min-w-24 border-b border-border p-1 text-left align-bottom text-xs font-medium"
									>Result</th
								>
								{#each table.headers as h, j (j)}
									<th class="min-w-36 border-b border-border p-1 text-left align-top font-normal">
										<select
											class="input min-h-9 py-0 text-xs"
											value={mapping.targets[j]}
											onchange={(e) => setTarget(j, (e.currentTarget as HTMLSelectElement).value)}
											aria-label="Where “{h}” goes"
										>
											<optgroup label="Basics">
												{#each BASICS as [value, label] (value)}
													<option {value} disabled={taken(value, j)}>{label}</option>
												{/each}
											</optgroup>
											{#if ctx.itemFields.length}
												<optgroup label="This list's fields">
													{#each ctx.itemFields as f (f.key)}
														<option value="field:{f.key}" disabled={taken(`field:${f.key}`, j)}
															>{f.label}</option
														>
													{/each}
												</optgroup>
											{/if}
											<optgroup label="New field named “{h}”">
												{#each FIELD_TYPES.filter((t) => NEW_FIELD_TYPES.includes(t.value)) as t (t.value)}
													<option value="new:{t.value}">New field · {t.label}</option>
												{/each}
											</optgroup>
											<optgroup label="When it happened (adds a log)">
												<option value="log:date" disabled={taken('log:date', j)}>Date</option>
												<option value="log:where" disabled={!hasDateCol || taken('log:where', j)}
													>Where</option
												>
												<option value="log:notes" disabled={!hasDateCol || taken('log:notes', j)}
													>Log notes</option
												>
												{#each ctx.logFields as f (f.key)}
													<option
														value="logfield:{f.key}"
														disabled={!hasDateCol || taken(`logfield:${f.key}`, j)}
													>
														{f.label}
													</option>
												{/each}
											</optgroup>
											<option value="skip">Skip this column</option>
										</select>
										<span
											class="mt-1 block truncate px-1 text-xs font-medium {mapping.targets[j] === 'skip'
												? 'text-muted line-through'
												: ''}"
											title={h}>{h}</span
										>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each visible as r (r.index)}
								{@const off = isSkipped(r)}
								<tr class={off ? 'opacity-50' : ''}>
									<td class="sticky left-0 z-10 border-b border-border bg-surface p-1 text-center">
										<input
											type="checkbox"
											class="h-4 w-4 accent-[var(--accent)]"
											checked={!off}
											disabled={r.result === 'blank'}
											onchange={(e) => (overrides[r.index] = (e.currentTarget as HTMLInputElement).checked)}
											aria-label="Import row {r.index + 1}"
										/>
									</td>
									<td class="border-b border-border px-2 py-1.5 text-xs whitespace-nowrap">
										{#if r.result === 'new'}<span class="badge">New</span>
										{:else if r.result === 'update'}<span class="badge">Updates</span>
										{:else if r.result === 'duplicate'}<span
												class="badge"
												title="The same name appears earlier in the sheet">Repeat name</span
											>
										{:else}<span class="badge">No name</span>{/if}
										{#if r.log}<span class="badge">+ log</span>{/if}
									</td>
									{#each table.rows[r.index] as raw, j (j)}
										{@const issue = r.issues.find((i) => i.col === j)}
										<td
											class="max-w-56 truncate border-b border-border px-2 py-1.5 {mapping.targets[j] ===
											'skip'
												? 'text-muted/60'
												: ''} {issue ? 'bg-danger/10 text-danger' : ''}"
											title={issue ? issue.message : raw}
										>
											{mapping.targets[j] === 'skip' ? raw : r.shown[j] || raw}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if rows.length > visible.length}
					<button class="btn btn-sm" onclick={() => (showAll = true)}>Show all {rows.length} rows</button>
				{/if}
			</section>

			<!-- 3. Import -->
			<section class="card space-y-3 p-4 sm:p-5">
				<h2 class="font-semibold">3. Import</h2>
				<p class="text-sm">
					<strong>{counts.created}</strong> new,
					<strong>{counts.updated}</strong> already in the list (updated, not duplicated){counts.logs
						? `, ${counts.logs} ${counts.logs === 1 ? 'log' : 'logs'}`
						: ''}{counts.skipped ? `, ${counts.skipped} left out` : ''}.
				</p>
				{#if newFields.length}
					<p class="text-sm text-muted">
						New fields will be added to {cat.name}: {newFields
							.map((f) => `${f.label} (${typeLabel(f.type).toLowerCase()})`)
							.join(', ')}.
					</p>
				{/if}
				{#if issueCount}
					<p class="text-sm text-muted">
						{issueCount}
						{issueCount === 1 ? 'cell' : 'cells'} (red) couldn't be used and will be left out. The rest of each
						row is still imported.
					</p>
				{/if}
				<p class="text-xs text-muted">
					Names that are already in the list are matched, so importing the same sheet again is safe. Empty
					cells never erase what's there.
				</p>
				{#if form?.message}<p class="error-box" role="alert">{form.message}</p>{/if}
				<form
					method="POST"
					action="?/import"
					use:enhance={() => {
						busy = true;
						return async ({ update }) => {
							await update({ reset: false });
							busy = false;
						};
					}}
				>
					<input type="hidden" name="text" value={text} />
					<input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
					<input type="hidden" name="skipped" value={JSON.stringify(skippedList)} />
					<button
						class="btn btn-primary"
						disabled={busy || !!problem || counts.created + counts.updated === 0}
					>
						{busy
							? 'Importing…'
							: `Import ${counts.created + counts.updated} ${counts.created + counts.updated === 1 ? 'row' : 'rows'}`}
					</button>
				</form>
			</section>
		{/if}
	{/if}
</div>
