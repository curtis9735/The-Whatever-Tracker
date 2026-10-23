import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '$lib/server/db';
import {
	categoryItemCount,
	deleteCategory,
	getCategoryBySlug,
	saveFieldChanges,
	updateCategory,
	type FieldChange
} from '$lib/server/services/categories';
import { deleteItem } from '$lib/server/services/items';
import {
	householdMembers,
	leaveList,
	listSharesOf,
	saveShares,
	setMyListSettings
} from '$lib/server/services/access';
import { enabledKinds } from '$lib/server/providers/registry';
import { setlistfmEnabled } from '$lib/server/providers/setlistfm';
import { CATEGORY_COLORS, KINDS, LOG_SOURCES, keepHiddenKinds } from '$lib/kinds';
import { cleanIcon } from '$lib/icons';
import { FIELD_TYPES, slugify } from '$lib/fields';
import type { FieldType, ShareRole } from '$lib/types';
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

const FieldList = z
	.array(
		z.object({
			id: z.number().int().positive().nullable(),
			scope: z.enum(['item', 'log']),
			type: z.enum(FIELD_TYPES.map((t) => t.value) as [FieldType, ...FieldType[]]),
			label: z.string().max(60),
			unit: z.string().max(20),
			options: z.string().max(20000),
			showOnCard: z.boolean(),
			removed: z.boolean()
		})
	)
	.max(200);

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.user!.id;
	// Anyone with the list sees this page: its owner the settings, the others their own choices for it
	const cat = getCategoryBySlug(userId, params.slug);
	const owner = cat.category.access === 'owner';
	const enabled = enabledKinds();
	const roles = new Map<number, ShareRole>();
	if (owner) for (const s of listSharesOf(cat.category.id)) roles.set(s.id, s.role);
	return {
		...cat,
		/** Everyone else here, and what they can do with the list (the owner's page only) */
		people: owner
			? householdMembers(userId).map((p) => ({ ...p, role: roles.get(p.id) ?? ('none' as const) }))
			: [],
		itemCount: categoryItemCount(cat.category.id),
		kinds: KINDS.map((k) => ({ ...k, enabled: enabled.has(k.key) })),
		logSources: LOG_SOURCES.map((s) => ({ ...s, enabled: setlistfmEnabled() })),
		colors: Object.entries(CATEGORY_COLORS),
		isNew: url.searchParams.get('new') === '1'
	};
};

function ownedCategory(userId: number, slug: string) {
	return getCategoryBySlug(userId, slug, 'owner').category;
}

const SHARE_CHOICES = new Map<string, ShareRole | null>([
	['none', null],
	['view', 'view'],
	['edit', 'edit']
]);

function parseOptions(raw: string) {
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
		const providerKinds = keepHiddenKinds(
			form
				.getAll('providerKinds')
				.map(String)
				.filter((k) => validKinds.has(k)),
			category.providerKinds
		);
		// Extras (setlists…) only go with the kind of list they belong to
		for (const s of LOG_SOURCES) {
			if (!s.forKinds.some((k) => providerKinds.includes(k))) {
				const i = providerKinds.indexOf(s.key);
				if (i !== -1) providerKinds.splice(i, 1);
			}
		}

		// Fields: renamed, reordered, added or removed on the page, all saved here
		let fieldsRaw: unknown;
		try {
			fieldsRaw = JSON.parse(String(form.get('fields_json') ?? '[]'));
		} catch {
			return fail(400, { message: 'The fields could not be read. Reload the page and try again.' });
		}
		const fieldList = FieldList.safeParse(fieldsRaw);
		if (!fieldList.success) {
			return fail(400, { message: 'The fields could not be read. Reload the page and try again.' });
		}
		const fields: FieldChange[] = [];
		for (const f of fieldList.data) {
			const label = f.label.trim();
			const options = parseOptions(f.options);
			if (!f.removed && !label) return fail(400, { message: 'Every field needs a name.' });
			const picks = f.type === 'select' || f.type === 'multiselect';
			if (!f.removed && f.id === null && picks && !options.length) {
				return fail(400, { message: `List the choices for “${label}”, separated by commas.` });
			}
			fields.push({ ...f, label, unit: f.unit.trim() || null, options });
		}

		// Sharing: one share_<userId> choice per person on the page (someone added since is left as is)
		const shares: { userId: number; role: ShareRole | null }[] = [];
		for (const p of householdMembers(userId)) {
			const choice = form.get(`share_${p.id}`);
			if (choice === null) continue;
			if (!SHARE_CHOICES.has(String(choice))) {
				return fail(400, { message: 'Sharing could not be read. Reload the page and try again.' });
			}
			shares.push({ userId: p.id, role: SHARE_CHOICES.get(String(choice))! });
		}

		const slug = db().transaction(() => {
			const s = updateCategory(userId, category.id, {
				name,
				icon: cleanIcon(form.get('icon')),
				color: color in CATEGORY_COLORS ? color : 'slate',
				statuses,
				providerKinds,
				showUpNext: form.get('showUpNext') === 'on',
				// Only on the page for lists of shows, movies or games; otherwise left as it is
				showInCalendar: form.has('calendar_setting') ? form.get('showInCalendar') === 'on' : undefined
			});
			saveFieldChanges(category.id, fields);
			saveShares(userId, category.id, shares);
			return s;
		});
		redirect(303, `/categories/${slug}/edit?saved=1`);
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
	},

	/** Someone the list is shared with: their own Up next and Calendar choices for it */
	mine: async ({ request, locals, params }) => {
		const userId = locals.user!.id;
		const { category } = getCategoryBySlug(userId, params.slug);
		const form = await request.formData();
		setMyListSettings(userId, category.id, {
			showUpNext: form.get('showUpNext') === 'on',
			// Only on the page for lists of shows, movies or games; otherwise left as it is
			showInCalendar: form.has('calendar_setting') ? form.get('showInCalendar') === 'on' : undefined
		});
		return { mineSaved: true };
	},

	/** Someone the list is shared with stops seeing it */
	leave: async ({ locals, params }) => {
		const userId = locals.user!.id;
		const { category } = getCategoryBySlug(userId, params.slug);
		if (category.access === 'owner') {
			return fail(400, { leaveMessage: "It's your list: delete it instead." });
		}
		leaveList(userId, category.id);
		redirect(303, '/categories');
	}
};
