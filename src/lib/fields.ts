import { z } from 'zod';
import type { FieldDef, FieldType } from './types';

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
	{ value: 'text', label: 'Short text' },
	{ value: 'longtext', label: 'Long text' },
	{ value: 'number', label: 'Number' },
	{ value: 'date', label: 'Date' },
	{ value: 'select', label: 'Pick one' },
	{ value: 'multiselect', label: 'Pick several' },
	{ value: 'boolean', label: 'Yes / no' },
	{ value: 'url', label: 'Link' }
];

/** Zod schema for one custom field's *raw form input*, producing the stored value (or undefined). */
export function fieldSchema(def: Pick<FieldDef, 'type' | 'options' | 'label'>) {
	const blankToUndefined = (v: unknown) =>
		typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v;

	switch (def.type) {
		case 'text':
			return z.preprocess(blankToUndefined, z.string().max(500).optional());
		case 'longtext':
			return z.preprocess(blankToUndefined, z.string().max(10000).optional());
		case 'number':
			return z.preprocess(
				(v) => {
					const s = blankToUndefined(v);
					return s === undefined ? undefined : Number(s);
				},
				z.number({ error: `${def.label} must be a number` }).optional()
			);
		case 'date':
			return z.preprocess(
				blankToUndefined,
				z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, `${def.label} must be a date`)
					.optional()
			);
		case 'url':
			return z.preprocess(
				blankToUndefined,
				z
					.string()
					.url(`${def.label} must be a link starting with http:// or https://`)
					.refine((u) => /^https?:\/\//i.test(u), `${def.label} must start with http:// or https://`)
					.optional()
			);
		case 'boolean':
			return z.preprocess(
				(v) => (v === undefined || v === null || v === '' ? undefined : v),
				z
					.union([z.literal('on'), z.literal('true'), z.literal('false'), z.boolean()])
					.transform((v) => v === true || v === 'on' || v === 'true')
					.optional()
			);
		case 'select':
			return z.preprocess(blankToUndefined, z.string().max(200).optional());
		case 'multiselect':
			return z.preprocess(
				(v) => {
					const arr = (Array.isArray(v) ? v : v === undefined ? [] : [v])
						.map((x) => String(x).trim())
						.filter(Boolean);
					return arr.length ? Array.from(new Set(arr)) : undefined;
				},
				z.array(z.string().max(200)).max(50).optional()
			);
	}
}

/**
 * Reads custom field values from form data. Field inputs are named `${prefix}${key}`.
 * Returns stored values (blank fields omitted) or the first validation error.
 */
export function parseCustomFields(
	defs: FieldDef[],
	form: FormData,
	prefix: string
): { values: Record<string, unknown>; error: string | null } {
	const values: Record<string, unknown> = {};
	for (const def of defs) {
		const name = prefix + def.key;
		const raw = def.type === 'multiselect' ? form.getAll(name) : (form.get(name) ?? undefined);
		const result = fieldSchema(def).safeParse(raw);
		if (!result.success) {
			return { values, error: result.error.issues[0]?.message ?? `${def.label} is invalid` };
		}
		if (result.data !== undefined && !(def.type === 'boolean' && result.data === false)) {
			values[def.key] = result.data;
		}
	}
	return { values, error: null };
}

export function formatFieldValue(def: Pick<FieldDef, 'type' | 'unit'>, value: unknown): string {
	if (value === undefined || value === null || value === '') return '';
	if (def.type === 'boolean') return value ? 'Yes' : 'No';
	if (Array.isArray(value)) return value.join(', ');
	const s = String(value);
	return def.unit ? `${s} ${def.unit}` : s;
}

export function slugify(input: string) {
	return (
		input
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'list'
	);
}

export function fieldKey(label: string) {
	return slugify(label).replace(/-/g, '_').slice(0, 40) || 'field';
}
