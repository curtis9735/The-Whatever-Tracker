<script lang="ts">
	import type { FieldDef, RatingScale } from '$lib/types';
	import FieldInput from './FieldInput.svelte';
	import RatingInput from './RatingInput.svelte';

	let {
		scale,
		logFields,
		values = {},
		dateDefault,
		locationLabel = 'Where',
		date = $bindable(),
		location = $bindable(),
		showDate = true,
		showRating = true
	}: {
		scale: RatingScale;
		logFields: FieldDef[];
		values?: {
			date?: string;
			rating?: number | null;
			notes?: string | null;
			location?: string | null;
			price?: number | null;
			custom?: Record<string, unknown>;
		};
		dateDefault: string;
		locationLabel?: string;
		date?: string;
		location?: string;
		/** Off when the surrounding form asks for the date itself (the Add form's "When") */
		showDate?: boolean;
		/** Off when the item's own rating doubles as this log's rating */
		showRating?: boolean;
	} = $props();

	// Seed unbound values once from the initial props
	// svelte-ignore state_referenced_locally
	if (date === undefined) date = values.date ?? dateDefault;
	// svelte-ignore state_referenced_locally
	if (location === undefined) location = values.location ?? '';
</script>

<div class="space-y-4">
	<div class="grid gap-4 sm:grid-cols-2">
		{#if showDate}
			<div>
				<label class="label" for="log_date">Date</label>
				<input class="input" id="log_date" name="log_date" type="date" required bind:value={date} />
			</div>
		{/if}
		<div>
			<label class="label" for="log_location">{locationLabel}</label>
			<input
				class="input"
				id="log_location"
				name="log_location"
				bind:value={location}
				placeholder="Home, a bar, a venue…"
			/>
		</div>
	</div>
	{#if showRating}
		<RatingInput
			{scale}
			name="log_rating"
			id="log_rating"
			value={values.rating ?? null}
			label="Rating this time"
		/>
	{/if}
	{#if logFields.length}
		<div class="grid gap-4 sm:grid-cols-2">
			{#each logFields as def (def.key)}
				<div class={def.type === 'longtext' || def.type === 'multiselect' ? 'sm:col-span-2' : ''}>
					<FieldInput {def} prefix="lf_" value={values.custom?.[def.key]} />
				</div>
			{/each}
		</div>
	{/if}
	<div>
		<label class="label" for="log_notes">Notes</label>
		<textarea class="input" id="log_notes" name="log_notes" rows="3">{values.notes ?? ''}</textarea>
	</div>
	<div class="sm:w-1/2">
		<label class="label" for="log_price"
			>Price paid <span class="font-normal text-muted">(optional)</span></label
		>
		<input class="input" id="log_price" name="log_price" inputmode="decimal" value={values.price ?? ''} />
	</div>
</div>
