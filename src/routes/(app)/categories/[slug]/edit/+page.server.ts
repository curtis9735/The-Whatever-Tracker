import { fail, redirect } from '@sveltejs/kit';
import { and, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '$lib/server/db';
import {
	categoryItemCount,
	deleteCategory,
	getCategoryBySlug,
	getFields,
	updateCategory
} from '$lib/server/services/categories';
import { deleteItem } from '$lib/server/services/items';
import { enabledKinds } from '$lib/server/providers/registry';
import { setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { CATEGORY_COLORS, KINDS, LOG_SOURCES } from '$lib/kinds';
import { cleanIcon } from '$lib/icons';
import { FIELD_TYPES, fieldKey, slugify } from '$lib/fields';
import type { FieldType, RatingScale } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

const StatusList = z
	.array(
		z.object({
			key: z.string().max(60).optional(),
			label: z.string().trim().min(1).max(60),
			group: z.enum(['planned', 'active', 'done', 'dropped'])
		})
	)
	.min(1, 'Keep at least one status.')
	.max(20);

const FIELD_TYPE_SET = new Set(FIELD_TYPES.map((t) => t.value));

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const cat = getCategoryBySlug(locals.user!.id, params.slug);
	const enabled = enabledKinds();
	return {
		...cat,
		itemCount: categoryItemCount(cat.category.id),
		kinds: KINDS.map((k) => ({ ...k, enabled: enabled.has(k.key) })),
		logSources: LOG_SOURCES.map((s) => ({ ...s, enabled: setlistfmEnabled() })),
		colors: Object.entries(CATEGORY_COLORS),
		isNew: url.searchParams.get('new') === '1'
	};
};

function ownedCategory(userId: number, slug: string) {
	return getCategoryBySlug(userId, slug).category;
}

function parseOptions(raw: FormDataEntryValue | null) {
	return Array.from(
		new Set(
			String(raw ?? '')
				.split(/[,\n]/)
				.map((s) => s.trim().slice(0, 100))
				.filter(Boolean)
		)
	).slice(0, 100);
}

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const category = ownedCategory(userId, params.slug);
		const form = await request.formData();
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 60);
		if (!name) return fail(400, { message: 'Give the list a name.' });
		const ratingScale = String(form.get('ratingScale')) as RatingScale;
		if (!['5star', '10', '100'].includes(ratingScale)) return fail(400, { message: 'Pick a rating scale.' });
		const color = String(form.get('color') ?? 'slate');

		let statusesRaw: unknown;
		try {
			statusesRaw = JSON.parse(String(form.get('statuses_json') ?? '[]'));
		} catch {
			return fail(400, { message: 'Statuses could not be read.' });
		}
		const parsed = StatusList.safeParse(statusesRaw);
		if (!parsed.success)
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Check the statuses.' });
		const used = new Set<string>();
		const statuses = parsed.data.map((s) => {
			let key = s.key || slugify(s.label);
			while (used.has(key)) key = `${key}-2`;
			used.add(key);
			return { key, label: s.label, group: s.group };
		});

		const validKinds = new Set<string>([...KINDS.map((k) => k.key), ...LOG_SOURCES.map((s) => s.key)]);
		const providerKinds = form
			.getAll('providerKinds')
			.map(String)
			.filter((k) => validKinds.has(k));

		const slug = updateCategory(userId, category.id, {
			name,
			icon: cleanIcon(form.get('icon')),
			color: color in CATEGORY_COLORS ? color : 'slate',
			ratingScale,
			statuses,
			providerKinds
		});
		redirect(303, `/categories/${slug}/edit?saved=1`);
	},

	addField: async ({ request, locals, params }) => {
		const category = ownedCategory(locals.user!.id, params.slug);
		const form = await request.formData();
		const label = String(form.get('label') ?? '')
			.trim()
			.slice(0, 60);
		const type = String(form.get('type')) as FieldType;
		const scope = form.get('scope') === 'log' ? 'log' : 'item';
		if (!label) return fail(400, { fieldMessage: 'Give the field a name.' });
		if (!FIELD_TYPE_SET.has(type)) return fail(400, { fieldMessage: 'Pick a field type.' });
		const options = parseOptions(form.get('options'));
		if ((type === 'select' || type === 'multiselect') && !options.length) {
			return fail(400, { fieldMessage: 'List the choices, separated by commas.' });
		}
		const existing = new Set(
			getFields(category.id)
				.filter((f) => f.scope === scope)
				.map((f) => f.key)
		);
		let key = fieldKey(label);
		for (let i = 2; existing.has(key); i++) key = `${fieldKey(label)}_${i}`;
		const order = db()
			.select({ m: max(schema.fieldDefinitions.sortOrder) })
			.from(schema.fieldDefinitions)
			.where(eq(schema.fieldDefinitions.categoryId, category.id))
			.get();
		db()
			.insert(schema.fieldDefinitions)
			.values({
				categoryId: category.id,
				scope,
				key,
				label,
				type,
				options,
				unit:
					String(form.get('unit') ?? '')
						.trim()
						.slice(0, 20) || null,
				showOnCard: form.get('showOnCard') === 'on',
				sortOrder: (order?.m ?? -1) + 1
			})
			.run();
		return { fieldAdded: true };
	},

	updateField: async ({ request, locals, params }) => {
		const category = ownedCategory(locals.user!.id, params.slug);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const label = String(form.get('label') ?? '')
			.trim()
			.slice(0, 60);
		if (!label) return fail(400, { fieldMessage: 'Fields need a name.' });
		db()
			.update(schema.fieldDefinitions)
			.set({
				label,
				options: parseOptions(form.get('options')),
				unit:
					String(form.get('unit') ?? '')
						.trim()
						.slice(0, 20) || null,
				showOnCard: form.get('showOnCard') === 'on'
			})
			.where(and(eq(schema.fieldDefinitions.id, id), eq(schema.fieldDefinitions.categoryId, category.id)))
			.run();
		return { fieldSaved: id };
	},

	moveField: async ({ request, locals, params }) => {
		const category = ownedCategory(locals.user!.id, params.slug);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const fields = getFields(category.id);
		const idx = fields.findIndex((f) => f.id === id);
		const swap = idx + (form.get('dir') === 'up' ? -1 : 1);
		if (idx < 0 || swap < 0 || swap >= fields.length) return;
		[fields[idx], fields[swap]] = [fields[swap], fields[idx]];
		db().transaction(() => {
			fields.forEach((f, i) =>
				db()
					.update(schema.fieldDefinitions)
					.set({ sortOrder: i })
					.where(eq(schema.fieldDefinitions.id, f.id))
					.run()
			);
		});
	},

	deleteField: async ({ request, locals, params }) => {
		const category = ownedCategory(locals.user!.id, params.slug);
		const id = Number((await request.formData()).get('id'));
		// Values stay in the items' data, so re-adding a field with the same name brings them back
		db()
			.delete(schema.fieldDefinitions)
			.where(and(eq(schema.fieldDefinitions.id, id), eq(schema.fieldDefinitions.categoryId, category.id)))
			.run();
	},

	delete: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const category = ownedCategory(userId, params.slug);
		const confirmName = String((await request.formData()).get('confirm') ?? '').trim();
		if (confirmName !== category.name) {
			return fail(400, { deleteMessage: `Type “${category.name}” to confirm.` });
		}
		if (categoryItemCount(category.id) > 0) {
			// Remove stored photo files first; rows cascade with the category
			const ids = db()
				.select({ id: schema.items.id })
				.from(schema.items)
				.where(eq(schema.items.categoryId, category.id))
				.all();
			for (const { id } of ids) await deleteItem(userId, id);
		}
		deleteCategory(userId, category.id);
		redirect(303, '/categories');
	}
};
