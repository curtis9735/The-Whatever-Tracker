<script lang="ts">
	import { PROVIDER_LABELS } from '$lib/kinds';
	import type { SearchResult } from '$lib/types';

	let {
		kinds,
		query,
		selected = $bindable(null),
		onselect,
		autoSearch = true
	}: {
		/** Enabled search kinds for this list, e.g. ["tmdb:movie"] */
		kinds: string[];
		/** Text to look up (usually the item's name as typed) */
		query: string;
		selected?: SearchResult | null;
		onselect?: (r: SearchResult | null) => void;
		/** Search as the query changes (otherwise only when the button is pressed) */
		autoSearch?: boolean;
	} = $props();

	let results = $state<SearchResult[]>([]);
	let inLibrary = $state<Record<string, number>>({});
	let status = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
	let error = $state('');
	let searchedFor = $state('');
	let controller: AbortController | null = null;

	const providers = $derived([...new Set(kinds.map((k) => k.split(':')[0]))]);
	const sourceNames = $derived(providers.map((p) => PROVIDER_LABELS[p] ?? p).join(' and '));

	$effect(() => {
		const q = query.trim();
		if (!autoSearch || selected || q.length < 2 || q === searchedFor) return;
		const t = setTimeout(() => run(q), 450);
		return () => clearTimeout(t);
	});

	export async function run(q = query.trim()) {
		if (q.length < 2) return;
		controller?.abort();
		const c = (controller = new AbortController());
		searchedFor = q;
		status = 'loading';
		error = '';
		try {
			const answers = await Promise.all(
				providers.map(async (p) => {
					const pk = kinds.filter((k) => k.startsWith(`${p}:`)).join(',');
					const res = await fetch(
						`/api/search/${p}?q=${encodeURIComponent(q)}&kinds=${encodeURIComponent(pk)}`,
						{
							signal: c.signal
						}
					);
					const d = await res.json().catch(() => ({}));
					if (!res.ok) throw new Error(d.message || `${PROVIDER_LABELS[p] ?? p} is unavailable`);
					return d as { results: SearchResult[]; inLibrary: Record<string, number> };
				})
			);
			if (c.signal.aborted) return;
			results = answers.flatMap((a) => a.results).slice(0, 8);
			inLibrary = Object.assign({}, ...answers.map((a) => a.inLibrary));
			status = 'done';
		} catch (e) {
			if ((e as Error).name === 'AbortError') return;
			error = (e as Error).message;
			status = 'error';
		}
	}

	function pick(r: SearchResult | null) {
		selected = r;
		onselect?.(r);
	}

	const libraryId = (r: SearchResult) => inLibrary[`${r.provider}:${r.kind}:${r.id}`];
</script>

<div class="rounded-xl border border-border bg-surface-2/50 p-3">
	{#if selected}
		<div class="flex items-center gap-3">
			<div class="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-surface-2">
				{#if selected.imageUrl}<img src={selected.imageUrl} alt="" class="h-full w-full object-cover" />{/if}
			</div>
			<div class="min-w-0 flex-1 text-sm">
				<p class="text-xs text-emerald-700 dark:text-emerald-400">
					Matched on {PROVIDER_LABELS[selected.provider]}: poster and details are added when you save
				</p>
				<p class="truncate font-medium">{selected.title}</p>
				{#if selected.subtitle}<p class="truncate text-xs text-muted">{selected.subtitle}</p>{/if}
			</div>
			<button type="button" class="btn btn-sm" onclick={() => pick(null)}>Change</button>
		</div>
		<input type="hidden" name="match_provider" value={selected.provider} />
		<input type="hidden" name="match_kind" value={selected.kind} />
		<input type="hidden" name="match_id" value={selected.id} />
	{:else}
		<div class="mb-2 flex items-center justify-between gap-2">
			<p class="text-sm font-medium">Find it on {sourceNames}</p>
			{#if !autoSearch || status === 'error'}
				<button type="button" class="btn btn-sm" onclick={() => run()} disabled={query.trim().length < 2}>
					Search
				</button>
			{/if}
		</div>
		{#if status === 'idle'}
			<p class="text-xs text-muted">Type the name and pick the right one to get the poster and details.</p>
		{:else if status === 'loading' && !results.length}
			<p class="text-xs text-muted">Searching…</p>
		{:else if status === 'error'}
			<p class="text-xs text-danger">{error}</p>
		{:else if !results.length}
			<p class="text-xs text-muted">
				No matches for “{searchedFor}”. Try a shorter name, or save it without a match.
			</p>
		{:else}
			<ul class="space-y-1" aria-label="Possible matches">
				{#each results as r (r.kindKey + r.id)}
					<li>
						{#if libraryId(r)}
							<a
								href="/items/{libraryId(r)}"
								class="flex items-center gap-3 rounded-lg p-1.5 text-sm hover:bg-surface-2"
							>
								{@render row(r)}
								<span class="badge bg-accent-soft text-accent">In library</span>
							</a>
						{:else}
							<button
								type="button"
								class="flex w-full items-center gap-3 rounded-lg p-1.5 text-left text-sm hover:bg-surface-2"
								onclick={() => pick(r)}
							>
								{@render row(r)}
								<span class="btn btn-sm pointer-events-none">Use</span>
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

{#snippet row(r: SearchResult)}
	<span class="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
		{#if r.imageUrl}<img src={r.imageUrl} alt="" loading="lazy" class="h-full w-full object-cover" />{/if}
	</span>
	<span class="min-w-0 flex-1">
		<span class="block truncate font-medium">{r.title}</span>
		<span class="block truncate text-xs text-muted">{r.subtitle ?? ''}</span>
	</span>
{/snippet}
