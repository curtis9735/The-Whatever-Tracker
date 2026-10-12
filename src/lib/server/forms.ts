import { parseCustomFields } from '$lib/fields';
import { parseRatingInput } from '$lib/ratings';
import { isFinished } from '$lib/status';
import type { FieldDef, StatusDef } from '$lib/types';
import type { Category } from './db/schema';
import { parseTagInput, type ItemInput, type LogInput } from './services/items';

type Parsed<T> = { ok: false; error: string } | ({ ok: true } & T);

const str = (form: FormData, name: string, max = 500) => {
	const v = String(form.get(name) ?? '').trim();
	return v ? v.slice(0, max) : null;
};

export function todayIso() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseItemForm(
	form: FormData,
	category: Category,
	fields: FieldDef[]
): Parsed<{ data: ItemInput & { custom: Record<string, unknown> }; tags: string[] }> {
	const title = str(form, 'title', 300);
	if (!title) return { ok: false, error: 'Give it a name.' };
	const custom = parseCustomFields(fields, form, 'cf_');
	if (custom.error) return { ok: false, error: custom.error };
	const status = str(form, 'status', 60);
	return {
		ok: true,
		data: {
			categoryId: category.id,
			title,
			subtitle: str(form, 'subtitle', 300),
			description: str(form, 'description', 20000),
			status: status && category.statuses.some((s) => s.key === status) ? status : null,
			rating: parseRatingInput(form.get('rating'), category.ratingScale),
			favorite: form.get('favorite') === 'on',
			barcode: str(form, 'barcode', 40)?.replace(/\s/g, '') ?? null,
			notes: str(form, 'notes', 20000),
			custom: custom.values
		},
		tags: parseTagInput(String(form.get('tags') ?? ''))
	};
}

/** Log inputs are prefixed `log_` / `lf_` so a log can share a form with an item. */
export function parseLogForm(
	form: FormData,
	category: Category,
	logFields: FieldDef[]
): Parsed<{ data: LogInput }> {
	const date = str(form, 'log_date', 10) ?? todayIso();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Pick a valid date.' };
	const custom = parseCustomFields(logFields, form, 'lf_');
	if (custom.error) return { ok: false, error: custom.error };
	const priceRaw = str(form, 'log_price', 20);
	const price = priceRaw === null ? null : Number(priceRaw.replace(',', '.'));
	if (price !== null && !Number.isFinite(price)) return { ok: false, error: 'Price must be a number.' };

	// `log_external` present but empty clears it; absent leaves it untouched
	let external: Record<string, unknown> | null | undefined = undefined;
	const ext = str(form, 'log_external', 50000);
	if (ext) {
		try {
			external = JSON.parse(ext);
		} catch {
			external = undefined;
		}
	} else if (form.has('log_external')) {
		external = null;
	}

	return {
		ok: true,
		data: {
			date,
			rating: parseRatingInput(form.get('log_rating'), category.ratingScale),
			notes: str(form, 'log_notes', 20000),
			location: str(form, 'log_location', 300),
			price,
			custom: custom.values,
			external
		}
	};
}

/**
 * The date to record as a new item's first log: only for finished statuses, and only if the
 * "When" date was left filled in (clearing it means "don't record when").
 */
export function firstLogDate(form: FormData, statuses: StatusDef[], status: string | null): string | null {
	if (!isFinished(statuses, status)) return null;
	const date = String(form.get('log_date') ?? '').trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}
