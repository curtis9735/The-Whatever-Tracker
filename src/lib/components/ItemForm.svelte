<script lang="ts">
	import type { Snippet } from 'svelte';
	import { toDisplay } from '$lib/ratings';
	import type { FieldDef, RatingScale, StatusDef } from '$lib/types';
	import FieldInput from './FieldInput.svelte';
	import RatingInput from './RatingInput.svelte';

	let {
		category,
		itemFields,
		values,
		allTags,
		extra,
		afterTitle,
		afterStatus,
		title = $bindable(),
		status = $bindable()
	}: {
		category: { ratingScale: RatingScale; statuses: StatusDef[] };
		itemFields: FieldDef[];
		values: {
			title?: string | null;
			subtitle?: string | null;
			description?: string | null;
			status?: string | null;
			rating?: number | null;
			favorite?: boolean;
			barcode?: string | null;
			notes?: string | null;
			tags?: string[];
			custom?: Record<string, unknown>;
		};
		allTags: string[];
		extra?: Snippet;
		/** Rendered right under the Name field (e.g. the metadata lookup) */
		afterTitle?: Snippet;
		/** The name as typed, for parents that react to it */
		title?: string;
		/** Rendered right under the Status row (e.g. "When" for finished statuses) */
		afterStatus?: Snippet;
		/** The chosen status key, for parents that react to it */
		status?: string;
	} = $props();

	// svelte-ignore state_referenced_locally
	if (title === undefined) title = values.title ?? '';
	// svelte-ignore state_referenced_locally
	if (status === undefined) status = values.status ?? category.statuses[0]?.key ?? '';

	// svelte-ignore state_referenced_locally
	let showMore = $state(!!(values.description || values.barcode));
	// Re-key the rating widget if the scale changes
	const ratingKey = $derived(`${category.ratingScale}:${toDisplay(values.rating, category.ratingScale)}`);
</script>

<div class="space-y-4">
	<div>
		<label class="label" for="title">Name</label>
		<input
			class="input text-lg font-medium"
			id="title"
			name="title"
			required
			maxlength="300"
			autocomplete="off"
			bind:value={title}
		/>
	</div>
	{@render afterTitle?.()}
	<div>
		<label class="label" for="subtitle">Subtitle <span class="font-normal text-muted">(optional)</span></label
		>
		<input
			class="input"
			id="subtitle"
			name="subtitle"
			maxlength="300"
			value={values.subtitle ?? ''}
			placeholder="Brand, year, artist…"
		/>
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<div>
			<label class="label" for="status">Status</label>
			<select class="input" id="status" name="status" bind:value={status}>
				{#each category.statuses as s (s.key)}
					<option value={s.key}>{s.label}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-end">
			<label class="flex min-h-11 items-center gap-2 text-sm">
				<input
					type="checkbox"
					name="favorite"
					class="h-5 w-5 accent-[var(--accent)]"
					checked={values.favorite}
				/>
				Favorite
			</label>
		</div>
	</div>
	{@render afterStatus?.()}

	{#key ratingKey}
		<RatingInput
			scale={category.ratingScale}
			value={values.rating ?? null}
			name="rating"
			label="Your rating"
		/>
	{/key}

	{#if itemFields.length}
		<div class="grid gap-4 sm:grid-cols-2">
			{#each itemFields as def (def.key)}
				<div class={def.type === 'longtext' || def.type === 'multiselect' ? 'sm:col-span-2' : ''}>
					<FieldInput {def} prefix="cf_" value={values.custom?.[def.key]} />
				</div>
			{/each}
		</div>
	{/if}

	<div>
		<label class="label" for="tags">Tags</label>
		<input
			class="input"
			id="tags"
			name="tags"
			list="tag-list"
			value={(values.tags ?? []).join(', ')}
			placeholder="gift, peated, date night"
		/>
		<datalist id="tag-list">
			{#each allTags as t (t)}<option value={t}></option>{/each}
		</datalist>
		<p class="hint">Separate with commas.</p>
	</div>

	<div>
		<label class="label" for="notes">Notes</label>
		<textarea class="input" id="notes" name="notes" rows="3">{values.notes ?? ''}</textarea>
	</div>

	{#if showMore}
		<div>
			<label class="label" for="description">Description</label>
			<textarea class="input" id="description" name="description" rows="4"
				>{values.description ?? ''}</textarea
			>
		</div>
		<div>
			<label class="label" for="barcode">Barcode</label>
			<input class="input" id="barcode" name="barcode" inputmode="numeric" value={values.barcode ?? ''} />
			<p class="hint">Scanning this barcode later takes you straight here.</p>
		</div>
	{:else}
		<input type="hidden" name="description" value={values.description ?? ''} />
		<input type="hidden" name="barcode" value={values.barcode ?? ''} />
		<button type="button" class="text-sm text-accent" onclick={() => (showMore = true)}>
			+ Description and barcode
		</button>
	{/if}

	{@render extra?.()}
</div>
