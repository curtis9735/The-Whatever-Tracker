import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sheet-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { getItemDetail } = await import('./services/items');
const { applySheetImport, listContext, previewSheetImport } = await import('./import/sheet');
const { guessMapping } = await import('$lib/import/sheet');
const { parseTable } = await import('$lib/import/table');
const { ImportError } = await import('./import/yamtrack');

let n = 0;
function setup() {
	const user = db()
		.insert(schema.users)
		.values({ username: `u${++n}`, displayName: 'u', passwordHash: 'x' })
		.returning()
		.get();
	const category = createCategoryFromTemplate(user.id, 'whiskey');
	return { userId: user.id, categoryId: category.id };
}

/** Imports the way the page does: guess the mapping, then apply it. */
function run(s: { userId: number; categoryId: number }, text: string, skipped: number[] = []) {
	const mapping = guessMapping(parseTable(text), listContext(s.userId, s.categoryId));
	return applySheetImport(s.userId, s.categoryId, text, mapping, skipped);
}

function items(s: { userId: number; categoryId: number }) {
	return db()
		.select()
		.from(schema.items)
		.all()
		.filter((i) => i.userId === s.userId && i.categoryId === s.categoryId);
}

const SHEET = [
	'Whiskey Name\tCost\tDistillery\tShelf\tDaniel Sampled\tDaniel Rating',
	'Accord Stone\t$9\t\tTop\t✓\t2.5/5   Really good',
	'Black Adder Raw Cask\t$17\t\t\t\t',
	'Boann Madeira Cask Finish\t$8\t\t\t✓\t4.5/5   Madeira finish'
].join('\n');

describe('spreadsheet import', () => {
	it('creates items with fields, status, rating, notes and a new field for the extra column', () => {
		const s = setup();
		const r = run(s, SHEET);
		expect(r).toMatchObject({ created: 3, updated: 0, logs: 0, newFields: ['Shelf'] });

		const rows = Object.fromEntries(items(s).map((i) => [i.title, i]));
		const accord = rows['Accord Stone'];
		expect(accord.status).toBe('tasted');
		expect(accord.rating).toBe(50);
		expect(accord.notes).toBe('Really good');
		expect(accord.custom).toEqual({ price: 9, shelf: 'Top' });
		expect(rows['Black Adder Raw Cask'].status).toBe('wishlist');
		expect(rows['Black Adder Raw Cask'].rating).toBeNull();
		expect(rows['Boann Madeira Cask Finish'].rating).toBe(90);

		// The new field exists on the list, ready to use
		const { itemFields } = getCategoryById(s.userId, s.categoryId);
		expect(itemFields.find((f) => f.key === 'shelf')).toMatchObject({ label: 'Shelf', type: 'text' });
		// And the items are searchable
		expect(getItemDetail(s.userId, accord.id).item.title).toBe('Accord Stone');
	});

	it('importing the same sheet again changes nothing', () => {
		const s = setup();
		run(s, SHEET);
		const before = items(s).map((i) => [i.title, i.status, i.rating, i.notes, JSON.stringify(i.custom)]);
		const r = run(s, SHEET);
		expect(r).toMatchObject({ created: 0, updated: 3, newFields: [] });
		expect(items(s)).toHaveLength(3);
		expect(items(s).map((i) => [i.title, i.status, i.rating, i.notes, JSON.stringify(i.custom)])).toEqual(
			before
		);
	});

	it('blank cells never erase what is there, and an existing status is not downgraded', () => {
		const s = setup();
		run(s, SHEET);
		// Same bottles, now with the cells emptied out
		run(
			s,
			'Whiskey Name\tCost\tDaniel Sampled\tDaniel Rating\nAccord Stone\t\t\t\nBlack Adder Raw Cask\t\t✓\t'
		);
		const rows = Object.fromEntries(items(s).map((i) => [i.title, i]));
		expect(rows['Accord Stone'].status).toBe('tasted'); // blank sampled cell: kept
		expect(rows['Accord Stone'].rating).toBe(50);
		expect(rows['Accord Stone'].custom).toMatchObject({ price: 9 });
		expect(rows['Black Adder Raw Cask'].status).toBe('tasted'); // a ✓ does update it
	});

	it('newer values win, and notes are added rather than replaced', () => {
		const s = setup();
		run(s, 'Whiskey Name\tCost\tNotes\nAccord Stone\t$9\tfirst thoughts');
		run(s, 'Whiskey Name\tCost\tNotes\nAccord Stone\t$12\tsecond thoughts');
		const [item] = items(s);
		expect(item.custom).toMatchObject({ price: 12 });
		expect(item.notes).toBe('first thoughts\n\nsecond thoughts');
	});

	it('rows can be left out, and names match without caring about case or punctuation', () => {
		const s = setup();
		const r = run(s, 'Whiskey Name\nBushmills 10-Year\nBushmills 12-Year\nBlack Bush', [1]);
		expect(r).toMatchObject({ created: 2, skipped: 1 });
		const again = run(s, 'Whiskey Name\nbushmills 10 year\nNew One');
		expect(again).toMatchObject({ created: 1, updated: 1 });
		expect(items(s)).toHaveLength(3);
	});

	it('a repeated name in the sheet updates the first row instead of making a copy', () => {
		const s = setup();
		const text = 'Whiskey Name\tCost\nAccord Stone\t$9\naccord stone\t$11';
		// Repeats are unticked on the page; ticking one still doesn't create a second item
		const r = run(s, text);
		expect(r.created + r.updated).toBe(2);
		expect(items(s)).toHaveLength(1);
		expect(items(s)[0].custom).toMatchObject({ price: 11 });
	});

	it('adds a log for each row with a date, once per date, and logs a wishlist item as done', () => {
		const s = setup();
		const text =
			'Whiskey Name\tDate\tWhere\tNose\tRating\nAccord Stone\t10/10/2026\tBar\tsmoke\t4/5\nBlack Adder\t\t\t\t';
		const r = run(s, text);
		expect(r).toMatchObject({ created: 2, logs: 1 });
		const accord = items(s).find((i) => i.title === 'Accord Stone')!;
		const detail = getItemDetail(s.userId, accord.id);
		expect(detail.logs).toHaveLength(1);
		expect(detail.logs[0]).toMatchObject({
			date: '2026-10-10',
			location: 'Bar',
			rating: 80,
			custom: { nose: 'smoke' }
		});
		expect(detail.item.lastLoggedAt).toBe('2026-10-10');
		expect(accord.status).not.toBe('wishlist'); // first status was Wishlist; a log moves it to done
		expect(items(s).find((i) => i.title === 'Black Adder')!.status).toBe('wishlist');

		expect(run(s, text)).toMatchObject({ created: 0, logs: 0 });
		expect(getItemDetail(s.userId, accord.id).logs).toHaveLength(1);
	});

	it('adds new choices to pick-one fields and links photos', () => {
		const s = setup();
		run(s, 'Whiskey Name\tType\tPhoto\nA\tbourbon\thttps://example.com/a.jpg\nB\tRye\t');
		const { itemFields } = getCategoryById(s.userId, s.categoryId);
		const type = itemFields.find((f) => f.key === 'type')!;
		expect(type.options).toContain('Rye');
		expect(type.options.filter((o) => o.toLowerCase() === 'bourbon')).toHaveLength(1);
		const a = items(s).find((i) => i.title === 'A')!;
		expect(a.custom).toEqual({ type: 'Bourbon' });
		const images = db()
			.select()
			.from(schema.images)
			.all()
			.filter((i) => i.itemId === a.id);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ kind: 'url_link', sourceUrl: 'https://example.com/a.jpg' });
		expect(a.coverImageId).toBe(images[0].id);
	});

	it('tags are added to the ones an item already has', () => {
		const s = setup();
		run(s, 'Whiskey Name\tTags\nA\tgift, peated');
		run(s, 'Whiskey Name\tTags\nA\tpeated, islay');
		const names = db()
			.select({ name: schema.tags.name })
			.from(schema.itemTags)
			.innerJoin(schema.tags, eq(schema.itemTags.tagId, schema.tags.id))
			.where(eq(schema.itemTags.itemId, items(s)[0].id))
			.all()
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(['gift', 'islay', 'peated']);
	});

	it('previews exactly what an import would do, without saving', () => {
		const s = setup();
		const mapping = guessMapping(parseTable(SHEET), listContext(s.userId, s.categoryId));
		const p = previewSheetImport(s.userId, s.categoryId, SHEET, mapping, []);
		expect(p.counts).toMatchObject({ created: 3, updated: 0 });
		expect(p.newFields).toEqual(['Shelf']);
		expect(items(s)).toHaveLength(0);
		expect(getCategoryById(s.userId, s.categoryId).itemFields.some((f) => f.key === 'shelf')).toBe(false);
	});

	it('refuses bad mappings and other people’s lists', async () => {
		const a = setup();
		const b = setup();
		const text = 'Whiskey Name\tCost\nA\t$9';
		const good = guessMapping(parseTable(text), listContext(a.userId, a.categoryId));
		expect(() =>
			applySheetImport(a.userId, a.categoryId, text, { ...good, targets: ['skip', 'skip'] }, [])
		).toThrow(ImportError);
		expect(() =>
			applySheetImport(a.userId, a.categoryId, text, { ...good, targets: ['basic:name', 'field:nope'] }, [])
		).toThrow(ImportError);
		expect(() => applySheetImport(a.userId, a.categoryId, 'Name only', good, [])).toThrow(ImportError);
		// Someone else's list is a 404, and nothing is written to it
		try {
			applySheetImport(b.userId, a.categoryId, text, good, []);
			throw new Error('expected an error');
		} catch (e) {
			expect((e as { status?: number }).status).toBe(404);
		}
		expect(items(a)).toHaveLength(0);
	});

	it('a rejected mapping creates no items and no fields', () => {
		const s = setup();
		const text = 'Whiskey Name\tShelf\nA\tTop';
		const good = guessMapping(parseTable(text), listContext(s.userId, s.categoryId));
		// "Where" without a Date column is refused before anything is written
		expect(() =>
			applySheetImport(s.userId, s.categoryId, text, { ...good, targets: ['basic:name', 'log:where'] }, [])
		).toThrow(ImportError);
		expect(items(s)).toHaveLength(0);
		expect(getCategoryById(s.userId, s.categoryId).itemFields.some((f) => f.key === 'shelf')).toBe(false);
	});
});
