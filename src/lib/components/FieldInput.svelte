<script lang="ts">
	import type { FieldDef } from '$lib/types';

	let { def, prefix, value }: { def: FieldDef; prefix: string; value: unknown } = $props();

	const name = $derived(prefix + def.key);
	const id = $derived(`f-${prefix}${def.key}`);
	const selected = $derived(new Set(Array.isArray(value) ? value.map(String) : []));
</script>

{#if def.type === 'boolean'}
	<label class="flex min-h-11 items-center gap-3">
		<input type="checkbox" {name} class="h-5 w-5 accent-[var(--accent)]" checked={value === true} />
		<span class="text-sm font-medium">{def.label}</span>
	</label>
{:else if def.type === 'multiselect'}
	<fieldset>
		<legend class="label">{def.label}</legend>
		<div class="flex flex-wrap gap-2">
			{#each def.options as opt (opt)}
				<label class="chip cursor-pointer has-[:checked]:chip-active">
					<input type="checkbox" {name} value={opt} class="sr-only" checked={selected.has(opt)} />
					{opt}
				</label>
			{/each}
		</div>
	</fieldset>
{:else}
	<div>
		<label class="label" for={id}>
			{def.label}{#if def.unit}<span class="font-normal text-muted"> ({def.unit})</span>{/if}
		</label>
		{#if def.type === 'longtext'}
			<textarea class="input" {id} {name} rows="3">{value ?? ''}</textarea>
		{:else if def.type === 'select'}
			<select class="input" {id} {name}>
				<option value="">–</option>
				{#each def.options as opt (opt)}
					<option value={opt} selected={value === opt}>{opt}</option>
				{/each}
				{#if value && !def.options.includes(String(value))}
					<option value={String(value)} selected>{String(value)}</option>
				{/if}
			</select>
		{:else if def.type === 'number'}
			<input class="input" {id} {name} type="number" step="any" inputmode="decimal" value={value ?? ''} />
		{:else if def.type === 'date'}
			<input class="input" {id} {name} type="date" value={value ?? ''} />
		{:else if def.type === 'url'}
			<input
				class="input"
				{id}
				{name}
				type="url"
				inputmode="url"
				placeholder="https://"
				value={value ?? ''}
			/>
		{:else}
			<input class="input" {id} {name} value={value ?? ''} />
		{/if}
	</div>
{/if}
