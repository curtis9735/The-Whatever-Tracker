import { getCategoryBySlug } from '$lib/server/services/categories';
import { listItems, type ListFilters } from '$lib/server/services/items';
import { rawDb } from '$lib/server/db';
import { parseRatingInput } from '$lib/ratings';
import type { PageServerLoad } from './$types';

const SORTS = ['recent', 'logged', 'rating', 'title', 'added'] as const;

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const userId = locals.user!.id;
	const { category, itemFields } = getCategoryBySlug(userId, params.slug);
	const sp = url.searchParams;

	const filterable = itemFields.filter((f) => f.type === 'select' || f.type === 'multiselect');
	const fieldKey = sp.get('field');
	const fieldDef = filterable.find((f) => f.key === fieldKey);
	const sortParam = sp.get('sort');
	const sort = (SORTS as readonly string[]).includes(sortParam ?? '')
		? (sortParam as ListFilters['sort'])
		: 'recent';

	const filters: ListFilters = {
		status: sp.get('status'),
		group: sp.get('group'),
		tag: sp.get('tag'),
		minRating: parseRatingInput(sp.get('min'), category.ratingScale),
		favorite: sp.get('fav') === '1',
		q: sp.get('q')?.trim() || null,
		field:
			fieldDef && sp.get('value')
				? { key: fieldDef.key, value: sp.get('value')!, multi: fieldDef.type === 'multiselect' }
				: null,
		sort,
		page: Number(sp.get('page') ?? 1) || 1,
		pageSize: 60
	};
	const { rows, total } = listItems(userId, category.id, category.statuses, filters);

	// Status counts for the chips
	const counts = rawDb()
		.prepare('SELECT status, COUNT(*) AS n FROM items WHERE category_id = ? AND user_id = ? GROUP BY status')
		.all(category.id, userId) as { status: string | null; n: number }[];

	const categoryTags = (
		rawDb()
			.prepare(
				`SELECT DISTINCT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id JOIN items i ON i.id = it.item_id
				 WHERE i.category_id = ? AND i.user_id = ? ORDER BY t.name`
			)
			.all(category.id, userId) as { name: string }[]
	).map((t) => t.name);

	return {
		category,
		cardFields: itemFields.filter((f) => f.showOnCard),
		filterable,
		rows,
		total,
		page: filters.page!,
		pageSize: filters.pageSize!,
		statusCounts: Object.fromEntries(counts.map((c) => [c.status ?? '', c.n])),
		tags: categoryTags,
		filters: {
			status: filters.status,
			group: filters.group,
			tag: filters.tag,
			min: sp.get('min') ?? '',
			fav: filters.favorite,
			q: filters.q ?? '',
			field: fieldDef?.key ?? '',
			value: sp.get('value') ?? '',
			sort
		},
		view: sp.get('view') === 'list' ? 'list' : 'grid'
	};
};
