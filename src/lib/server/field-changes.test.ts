import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fields-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById, getFields, saveFieldChanges } =
	await import('./services/categories');
const { createItem, getOwnedItem } = await import('./services/items');

function setup() {
	const user = db()
		.insert(schema.users)
		.values({ username: `u${Math.random()}`, displayName: 'u', passwordHash: 'x' })
		.returning()
		.get();
	const cat = createCategoryFromTemplate(user.id, 'whiskey');
	return { userId: user.id, catId: cat.id };
}

/** The page sends every field in display order, the way the settings form does. */
function asSent(catId: number) {
	return getFields(catId).map((f) => ({
		id: f.id as number | null,
		scope: f.scope,
		type: f.type,
		label: f.label,
		unit: f.unit,
		options: f.options ?? [],
		showOnCard: f.showOnCard,
		removed: false
	}));
}

describe('saving the fields from list settings', () => {
	it('renames, reorders, removes and adds in one go', () => {
		const { userId, catId } = setup();
		const sent = asSent(catId);
		const distillery = sent.find((f) => f.label === 'Distillery')!;
		const price = sent.find((f) => f.label === 'Price')!;
		distillery.label = 'Made by';
		distillery.showOnCard = false;
		price.removed = true;
		// Move "Made by" to the end of the list
		const reordered = [...sent.filter((f) => f !== distillery), distillery];
		reordered.push({
			id: null,
			scope: 'item',
			type: 'number',
			label: 'Bottle size',
			unit: 'ml',
			options: [],
			showOnCard: true,
			removed: false
		});
		saveFieldChanges(catId, reordered);

		const { itemFields } = getCategoryById(userId, catId);
		const labels = itemFields.map((f) => f.label);
		expect(labels).not.toContain('Price');
		expect(labels).not.toContain('Distillery');
		expect(labels.slice(-2)).toEqual(['Made by', 'Bottle size']);
		expect(itemFields.find((f) => f.label === 'Made by')).toMatchObject({
			key: 'distillery',
			showOnCard: false
		});
		expect(itemFields.find((f) => f.label === 'Bottle size')).toMatchObject({
			key: 'bottle_size',
			type: 'number',
			unit: 'ml',
			showOnCard: true
		});
	});

	it("keeps an item's values when its field is renamed or removed", () => {
		const { userId, catId } = setup();
		const item = createItem(userId, {
			categoryId: catId,
			title: 'Lagavulin 16',
			custom: { distillery: 'Lagavulin', price: 90 }
		});
		const sent = asSent(catId);
		sent.find((f) => f.label === 'Price')!.removed = true;
		saveFieldChanges(catId, sent);
		expect(getOwnedItem(userId, item.id).custom).toEqual({ distillery: 'Lagavulin', price: 90 });
	});

	it("can't change an existing field's type, and only pick-one fields keep choices", () => {
		const { userId, catId } = setup();
		const sent = asSent(catId);
		const type = sent.find((f) => f.label === 'Type')!;
		const age = sent.find((f) => f.label === 'Age')!;
		type.options = ['Single Malt', 'Bourbon', 'Rye'];
		age.type = 'text';
		age.options = ['nonsense'];
		saveFieldChanges(catId, sent);
		const { itemFields } = getCategoryById(userId, catId);
		expect(itemFields.find((f) => f.label === 'Type')!.options).toEqual(['Single Malt', 'Bourbon', 'Rye']);
		expect(itemFields.find((f) => f.label === 'Age')).toMatchObject({ type: 'number', options: [] });
	});

	it("ignores fields from another list, and keeps fields the page didn't send", () => {
		const a = setup();
		const b = setup();
		const foreign = getFields(b.catId)[0];
		const sent = asSent(a.catId).slice(0, 2);
		saveFieldChanges(a.catId, [
			...sent,
			{ ...sent[0], id: foreign.id, label: 'Hijacked', removed: false },
			{ ...sent[0], id: getFields(b.catId)[1].id, removed: true }
		]);
		expect(getFields(b.catId).map((f) => f.label)).not.toContain('Hijacked');
		expect(getFields(b.catId)).toHaveLength(asSent(b.catId).length);
		// The fields that weren't sent are still there, after the sent ones
		expect(getFields(a.catId)).toHaveLength(asSent(a.catId).length);
		expect(
			getFields(a.catId)
				.slice(0, 2)
				.map((f) => f.id)
		).toEqual(sent.map((f) => f.id));
	});
});
