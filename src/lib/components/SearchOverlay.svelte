<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { KINDS, PROVIDER_LABELS, SETLIST_SOURCE } from '$lib/kinds';
	import { isFinished } from '$lib/status';
	import type { LocalSearchHit, NormalizedMetadata, SearchResult, StatusDef } from '$lib/types';
	import BarcodeScanner from './BarcodeScanner.svelte';
	import Icon from './Icon.svelte';
	import Rating from './Rating.svelte';
	import RatingInput from './RatingInput.svelte';

	interface Cat {
		id: number;
		name: string;
		slug: string;
		icon: string;
		statuses: StatusDef[];
		providerKinds: string[];
	}

	let {
		open = $bindable(false),
		categories,
		searchKinds,
		setlistReady = false
	}: { open?: boolean; categories: Cat[]; searchKinds: string[]; setlistReady?: boolean } = $props();

	let dialog: HTMLDialogElement;
	let input = $state<HTMLInputElement>();
	let q = $state('');
	let mode = $state<'search' | 'scan' | 'preview'>('search');

	type GroupState = { status: 'loading' | 'done' | 'error'; message?: string };
	let local = $state<{ status: 'idle' | 'loading' | 'done' | 'error'; hits: LocalSearchHit[] }>({
		status: 'idle',
		hits: []
	});
	let external = $state<Record<string, GroupState>>({});
	let results = $state<SearchResult[]>([]);
	let inLibrary = $state<Record<string, number>>({});
	let controller: AbortController | null = null;

	const providers = $derived([...new Set(searchKinds.map((k) => k.split(':')[0]))]);
	const groups = $derived(
		KINDS.filter((k) => searchKinds.includes(k.key)).map((k) => ({
			...k,
			items: results.filter((r) => r.kindKey === k.key),
			state: external[k.provider]
		}))
	);
	const term = $derived(q.trim());

	$effect(() => {
		if (open && !dialog.open) {
			dialog.showModal();
			tick().then(() => {
				if (mode === 'search') {
					input?.focus();
					input?.select();
				}
			});
		} else if (!open && dialog.open) dialog.close();
	});

	$effect(() => {
		const t = term;
		const timer = setTimeout(() => run(t), 250);
		return () => clearTimeout(timer);
	});

	function run(t: string) {
		controller?.abort();
		if (t.length < 2) {
			local = { status: 'idle', hits: [] };
			external = {};
			results = [];
			return;
		}
		const c = (controller = new AbortController());
		local = { status: 'loading', hits: local.hits };
		fetch(`/api/search/local?q=${encodeURIComponent(t)}`, { signal: c.signal })
			.then((r) => (r.ok ? r.json() : Promise.reject(r)))
			.then((d) => (local = { status: 'done', hits: d.hits }))
			.catch((e) => {
				if (e?.name !== 'AbortError') local = { status: 'error', hits: [] };
			});

		results = [];
		inLibrary = {};
		const next: Record<string, GroupState> = {};
		for (const p of providers) next[p] = { status: 'loading' };
		external = next;
		for (const p of providers) {
			const kinds = searchKinds.filter((k) => k.startsWith(`${p}:`)).join(',');
			fetch(`/api/search/${p}?q=${encodeURIComponent(t)}&kinds=${encodeURIComponent(kinds)}`, {
				signal: c.signal
			})
				.then(async (r) => {
					const d = await r.json().catch(() => ({}));
					if (!r.ok) throw new Error(d.message || `${PROVIDER_LABELS[p] ?? p} is unavailable`);
					return d;
				})
				.then((d) => {
					if (c.signal.aborted) return;
					results = [...results, ...d.results];
					inLibrary = { ...inLibrary, ...d.inLibrary };
					external[p] = { status: 'done' };
				})
				.catch((e) => {
					if (e?.name === 'AbortError' || c.signal.aborted) return;
					external[p] = { status: 'error', message: e.message };
				});
		}
	}

	function close() {
		open = false;
		mode = 'search';
		preview = null;
	}

	function onDialogClose() {
		open = false;
		mode = 'search';
	}

	async function go(href: string) {
		close();
		await goto(href);
	}

	// --- Preview / add ---------------------------------------------------------------
	let preview = $state<SearchResult | null>(null);
	let details = $state<NormalizedMetadata | null>(null);
	let detailsError = $state('');
	let addCategoryId = $state<number | null>(null);
	let addStatus = $state<string>('');
	let logDate = $state(today());
	let adding = $state(false);
	let addError = $state('');
	let ratingForm: HTMLFormElement | undefined = $state();

	const addCategory = $derived(categories.find((c) => c.id === addCategoryId) ?? null);
	const sortedCats = $derived(
		preview
			? [...categories].sort(
					(a, b) =>
						Number(b.providerKinds.includes(preview!.kindKey)) -
						Number(a.providerKinds.includes(preview!.kindKey))
				)
			: categories
	);

	function today() {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	function libraryId(r: SearchResult) {
		return inLibrary[`${r.provider}:${r.kind}:${r.id}`];
	}

	async function openPreview(r: SearchResult) {
		preview = r;
		details = null;
		detailsError = '';
		addError = '';
		logDate = today();
		mode = 'preview';
		const cat = categories.find((c) => c.providerKinds.includes(r.kindKey)) ?? categories[0];
		addCategoryId = cat?.id ?? null;
		addStatus = cat?.statuses[0]?.key ?? '';
		try {
			const res = await fetch(`/api/details/${r.provider}/${r.kind}/${encodeURIComponent(r.id)}`);
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Could not load details');
			if (preview === r) details = d.details;
		} catch (e) {
			if (preview === r) detailsError = (e as Error).message;
		}
	}

	function onCategoryChange() {
		addStatus = addCategory?.statuses[0]?.key ?? '';
	}

	// Lists with setlist.fm turned on get the show from that day attached to the first log
	const showFlow = $derived(setlistReady && !!addCategory?.providerKinds.includes(SETLIST_SOURCE));
	// A finished status (Completed, Seen…) records when as the first log; others add no log
	const finishedAdd = $derived(!!addCategory && isFinished(addCategory.statuses, addStatus));

	async function add() {
		if (!preview || !addCategoryId) return;
		adding = true;
		addError = '';
		const fd = ratingForm ? new FormData(ratingForm) : null;
		const rating = fd?.get('rating');
		const when = finishedAdd && logDate ? logDate : null;
		try {
			const res = await fetch('/api/items/from-provider', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: preview.provider,
					kind: preview.kind,
					id: preview.id,
					categoryId: addCategoryId,
					status: addStatus || null,
					rating: rating === '' || rating === null || rating === undefined ? null : Number(rating),
					logDate: when
				})
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Could not add it');
			inLibrary = { ...inLibrary, [`${preview.provider}:${preview.kind}:${preview.id}`]: d.id };
			await go(d.next ?? `/items/${d.id}`);
		} catch (e) {
			addError = (e as Error).message;
		} finally {
			adding = false;
		}
	}

	// --- Barcode ---------------------------------------------------------------------
	let barcodeBusy = $state(false);
	let barcodeMessage = $state('');

	async function onBarcode(code: string) {
		barcodeBusy = true;
		barcodeMessage = '';
		try {
			const res = await fetch(`/api/barcode/${code}`);
			const d = await res.json();
			if (!res.ok) throw new Error(d.message || 'Lookup failed');
			if (d.library.length === 1) return go(`/items/${d.library[0].id}`);
			if (d.library.length > 1) {
				mode = 'search';
				local = { status: 'done', hits: d.library };
				return;
			}
			const params = new URLSearchParams({ barcode: code });
			if (d.product) {
				params.set('title', d.product.title);
				if (d.product.brand) params.set('subtitle', d.product.brand);
				if (d.product.imageUrl) params.set('image', d.product.imageUrl);
			}
			await go(`/items/new?${params}`);
		} catch (e) {
			barcodeMessage = (e as Error).message;
			mode = 'search';
		} finally {
			barcodeBusy = false;
		}
	}

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			(dialog.querySelector('[data-result]') as HTMLElement | null)?.focus();
		}
	}

	function onListKey(e: KeyboardEvent) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const all = [...dialog.querySelectorAll<HTMLElement>('[data-result]')];
		const i = all.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		e.preventDefault();
		if (e.key === 'ArrowUp' && i === 0) input?.focus();
		else all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onDialogClose}
	onclick={(e) => e.target === dialog && close()}
	class="m-0 h-dvh max-h-none w-full max-w-none bg-bg p-0 text-fg backdrop:bg-black/50 backdrop:backdrop-blur-sm md:mx-auto md:mt-[8vh] md:h-auto md:max-h-[80vh] md:max-w-2xl md:rounded-2xl md:border md:border-border md:shadow-2xl"
	aria-label="Search"
>
	<div class="flex h-full flex-col md:max-h-[80vh]">
		<!-- Search bar -->
		<div
			class="flex items-center gap-2 border-b border-border px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
		>
			{#if mode !== 'search'}
				<button class="btn btn-ghost btn-icon" onclick={() => (mode = 'search')} aria-label="Back to results">
					<Icon name="chevron-left" />
				</button>
			{:else}
				<Icon name="search" class="ml-2 shrink-0 text-muted" />
			{/if}
			<input
				bind:this={input}
				bind:value={q}
				onkeydown={onInputKey}
				oninput={() => (mode = 'search')}
				class="min-h-11 w-full bg-transparent px-1 text-base outline-none placeholder:text-muted"
				placeholder="Search everything…"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="search"
				type="search"
				aria-label="Search everything"
			/>
			<button
				class="btn btn-ghost btn-icon"
				onclick={() => (mode = mode === 'scan' ? 'search' : 'scan')}
				aria-label="Scan a barcode"
				title="Scan a barcode"
			>
				<Icon name="barcode" />
			</button>
			<button class="btn btn-ghost btn-icon" onclick={close} aria-label="Close search">
				<Icon name="x" />
			</button>
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="flex-1 overflow-y-auto overscroll-contain px-3 py-3 pb-safe" onkeydown={onListKey}>
			{#if mode === 'scan'}
				{#if barcodeBusy}
					<p class="py-10 text-center text-sm text-muted">Looking it up…</p>
				{:else}
					<BarcodeScanner onresult={onBarcode} oncancel={() => (mode = 'search')} />
				{/if}
			{:else if mode === 'preview' && preview}
				{@render previewPanel(preview)}
			{:else}
				{#if barcodeMessage}<p class="error-box mb-3">{barcodeMessage}</p>{/if}
				{#if term.length < 2}
					<div class="px-1 py-6 text-sm text-muted">
						<p class="mb-4">
							Type to search your library{searchKinds.length ? ' and every connected source at once' : ''}.
						</p>
						{#if categories.length}
							<p class="section-title mb-2">Add something new</p>
							<div class="flex flex-wrap gap-2">
								{#each categories as c (c.id)}
									<button class="chip" onclick={() => go(`/items/new?category=${c.slug}`)}>
										<span>{c.icon}</span>{c.name}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<!-- Library -->
					<section class="mb-5">
						<h2 class="section-title mb-2 px-1">In your library</h2>
						{#if local.status === 'loading' && !local.hits.length}
							{@render skeleton()}
						{:else if local.hits.length === 0}
							<p class="px-1 text-sm text-muted">Nothing yet.</p>
						{:else}
							<ul class="space-y-1">
								{#each local.hits as h (h.id)}
									<li>
										<a
											href="/items/{h.id}"
											data-result
											onclick={(e) => {
												e.preventDefault();
												go(`/items/${h.id}`);
											}}
											class="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
										>
											{@render thumb(h.imageUrl, h.categoryIcon)}
											<div class="min-w-0 flex-1">
												<p class="truncate font-medium">{h.title}</p>
												<p class="truncate text-xs text-muted">
													{h.categoryIcon}
													{h.categoryName}{h.subtitle ? ` · ${h.subtitle}` : ''}{h.status
														? ` · ${h.status}`
														: ''}
												</p>
											</div>
											<Rating value={h.rating} class="text-sm" />
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<!-- External groups -->
					{#each groups as g (g.key)}
						{#if g.state?.status === 'loading' || g.items.length || g.state?.status === 'error'}
							<section class="mb-5">
								<h2 class="section-title mb-2 flex items-center gap-2 px-1">
									{g.group}
									<span class="font-normal tracking-normal normal-case">· {PROVIDER_LABELS[g.provider]}</span>
								</h2>
								{#if g.state?.status === 'loading' && !g.items.length}
									{@render skeleton()}
								{:else if g.state?.status === 'error'}
									<p class="px-1 text-sm text-muted">{g.state.message}</p>
								{:else}
									<ul class="space-y-1">
										{#each g.items as r (r.kindKey + r.id)}
											<li>
												<button
													data-result
													onclick={() => {
														const id = libraryId(r);
														if (id) go(`/items/${id}`);
														else openPreview(r);
													}}
													class="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
												>
													{@render thumb(r.imageUrl ?? null, '·')}
													<div class="min-w-0 flex-1">
														<p class="truncate font-medium">{r.title}</p>
														{#if r.subtitle}<p class="truncate text-xs text-muted">{r.subtitle}</p>{/if}
													</div>
													{#if libraryId(r)}
														<span class="badge bg-accent-soft text-accent">In library</span>
													{:else}
														<Icon name="plus" size={18} class="text-muted" />
													{/if}
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							</section>
						{/if}
					{/each}

					<!-- Manual create -->
					{#if categories.length}
						<section class="mb-2 rounded-2xl border border-dashed border-border p-3">
							<p class="mb-2 text-sm">
								Create <strong>“{term}”</strong> in…
							</p>
							<div class="flex flex-wrap gap-2">
								{#each categories as c (c.id)}
									<button
										class="chip"
										data-result
										onclick={() => go(`/items/new?category=${c.slug}&title=${encodeURIComponent(term)}`)}
									>
										<span>{c.icon}</span>{c.name}
									</button>
								{/each}
							</div>
						</section>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
</dialog>

{#snippet thumb(url: string | null, fallback: string)}
	<div
		class="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-lg"
	>
		{#if url}
			<img
				src={url}
				alt=""
				loading="lazy"
				class="h-full w-full object-cover"
				onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
			/>
		{:else}
			<span aria-hidden="true">{fallback}</span>
		{/if}
	</div>
{/snippet}

{#snippet skeleton()}
	<div class="space-y-2" aria-hidden="true">
		{#each [1, 2] as i (i)}
			<div class="flex animate-pulse items-center gap-3 p-2">
				<div class="h-14 w-10 rounded-md bg-surface-2"></div>
				<div class="flex-1 space-y-2">
					<div class="h-3 w-2/3 rounded bg-surface-2"></div>
					<div class="h-3 w-1/3 rounded bg-surface-2"></div>
				</div>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet previewPanel(r: SearchResult)}
	{@const d = details}
	<div class="space-y-4">
		<div class="flex gap-4">
			<div class="h-36 w-24 shrink-0 overflow-hidden rounded-lg bg-surface-2">
				{#if d?.imageUrl ?? r.imageUrl}
					<img src={d?.imageUrl ?? r.imageUrl} alt="" class="h-full w-full object-cover" />
				{/if}
			</div>
			<div class="min-w-0">
				<p class="text-xs text-muted">{PROVIDER_LABELS[r.provider]}</p>
				<h2 class="text-lg leading-tight font-semibold">{d?.title ?? r.title}</h2>
				{#if d?.subtitle ?? r.subtitle}<p class="mt-1 text-sm text-muted">{d?.subtitle ?? r.subtitle}</p>{/if}
				{#if d?.genres?.length}
					<div class="mt-2 flex flex-wrap gap-1">
						{#each d.genres.slice(0, 4) as g (g)}<span class="badge">{g}</span>{/each}
					</div>
				{/if}
			</div>
		</div>
		{#if detailsError}
			<p class="error-box">{detailsError}</p>
		{:else if !d}
			<p class="text-sm text-muted">Loading details…</p>
		{:else}
			{#if d.description}<p class="line-clamp-5 text-sm whitespace-pre-line">{d.description}</p>{/if}
			{#if d.facts.length}
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
					{#each d.facts.slice(0, 5) as f (f.label)}
						<dt class="text-muted">{f.label}</dt>
						<dd class="truncate">{f.value}</dd>
					{/each}
				</dl>
			{/if}
		{/if}

		<div class="card space-y-3 p-4">
			{#if !categories.length}
				<p class="text-sm">Create a category first, then you can add this.</p>
			{:else}
				<div>
					<label class="label" for="add-cat">Add to</label>
					<select class="input" id="add-cat" bind:value={addCategoryId} onchange={onCategoryChange}>
						{#each sortedCats as c (c.id)}
							<option value={c.id}>{c.icon} {c.name}</option>
						{/each}
					</select>
				</div>
				{#if addCategory}
					<div>
						<label class="label" for="add-status">Status</label>
						<select class="input" id="add-status" bind:value={addStatus}>
							{#each addCategory.statuses as s (s.key)}<option value={s.key}>{s.label}</option>{/each}
						</select>
					</div>
					{#if finishedAdd}
						<!-- Finished status: it already happened, so record when as the first log -->
						<div>
							<label class="label" for="add-when">When</label>
							<input class="input" id="add-when" type="date" bind:value={logDate} />
							<p class="hint">
								{showFlow
									? "The show's venue and setlist are pulled from setlist.fm for that day."
									: 'Saved as the first entry in its history. Clear the date to skip.'}
							</p>
						</div>
					{/if}
					<form bind:this={ratingForm} onsubmit={(e) => e.preventDefault()}>
						{#key addCategory.id}
							<RatingInput name="rating" id="add-rating" />
						{/key}
					</form>
				{/if}
				{#if addError}<p class="error-box">{addError}</p>{/if}
				<button class="btn btn-primary w-full" onclick={add} disabled={adding || !addCategoryId}>
					{adding ? 'Adding…' : `Add to ${addCategory?.name ?? 'library'}`}
				</button>
			{/if}
		</div>
		{#if r.url}
			<a
				href={r.url}
				target="_blank"
				rel="noopener noreferrer"
				class="flex items-center gap-1 text-sm text-accent"
			>
				View on {PROVIDER_LABELS[r.provider]}
				<Icon name="external" size={14} />
			</a>
		{/if}
	</div>
{/snippet}
