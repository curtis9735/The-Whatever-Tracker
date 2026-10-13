import { describe, expect, it } from 'vitest';
import {
	buildRows,
	countRows,
	defaultSkipped,
	guessMapping,
	normTitle,
	parseBooleanCell,
	parseDateCell,
	parseNumberCell,
	parseRatingCell,
	planNewFields,
	validateMapping,
	withNewFields,
	type ListContext
} from './sheet';
import { detectDelimiter, MAX_ROWS, parseTable } from './table';

// The Whiskey template's list shape
const whiskey: ListContext = {
	name: 'Whiskey',
	ratingScale: '100',
	statuses: [
		{ key: 'wishlist', label: 'Wishlist', group: 'planned' },
		{ key: 'sealed', label: 'Sealed', group: 'active' },
		{ key: 'open', label: 'Open', group: 'active' },
		{ key: 'finished', label: 'Finished', group: 'done' },
		{ key: 'tasted', label: 'Tasted', group: 'done' }
	],
	itemFields: [
		{
			key: 'distillery',
			label: 'Distillery',
			type: 'text',
			scope: 'item',
			options: [],
			unit: null,
			showOnCard: true
		},
		{
			key: 'type',
			label: 'Type',
			type: 'select',
			scope: 'item',
			options: ['Single Malt', 'Bourbon', 'Irish'],
			unit: null,
			showOnCard: false
		},
		{ key: 'age', label: 'Age', type: 'number', scope: 'item', options: [], unit: 'yrs', showOnCard: true },
		{
			key: 'price',
			label: 'Price',
			type: 'number',
			scope: 'item',
			options: [],
			unit: null,
			showOnCard: false
		}
	],
	logFields: [
		{ key: 'nose', label: 'Nose', type: 'longtext', scope: 'log', options: [], unit: null, showOnCard: false }
	],
	existing: {}
};

// Rows from the sheet pasted straight out of a spreadsheet (tab-separated)
const SHEET = [
	['Whiskey Name', 'Cost', 'Distillery', 'Location', 'Daniel Sampled', 'Daniel Rating'],
	['Accord Stone', '$9', '', '', '✓', '2.5/5   Really good'],
	['Black Adder Raw Cask', '$17', '', '', '', ''],
	['Blue Spot Irish Whiskey 7 Year', '', 'Spot', '', '✓', '3/5'],
	['Boann Madeira Cask Finish', '$8', '', '', '✓', '4.5/5   Madeira finish']
]
	.map((r) => r.join('\t'))
	.join('\n');

describe('reading pasted and CSV tables', () => {
	it('reads a spreadsheet paste', () => {
		const t = parseTable(SHEET);
		expect(t.headers).toEqual([
			'Whiskey Name',
			'Cost',
			'Distillery',
			'Location',
			'Daniel Sampled',
			'Daniel Rating'
		]);
		expect(t.rows).toHaveLength(4);
		expect(t.rows[0]).toEqual(['Accord Stone', '$9', '', '', '✓', '2.5/5   Really good']);
	});

	it('handles quoted commas, quotes and newlines in a CSV', () => {
		const t = parseTable('Name,Notes\r\n"Lagavulin 16","Smoky, ""peaty""\nand long"\r\nArdbeg,ok\r\n');
		expect(t.rows).toEqual([
			['Lagavulin 16', 'Smoky, "peaty"\nand long'],
			['Ardbeg', 'ok']
		]);
	});

	it('detects semicolons, drops a BOM, blank lines and empty trailing columns', () => {
		expect(detectDelimiter('a;b;c')).toBe(';');
		expect(detectDelimiter('a,b;c')).toBe(',');
		const t = parseTable('﻿Name;Cost;\n\nOne;5;\nTwo;6;\n');
		expect(t.headers).toEqual(['Name', 'Cost']);
		expect(t.rows).toEqual([
			['One', '5'],
			['Two', '6']
		]);
	});

	it('names blank headers and caps very long sheets', () => {
		expect(parseTable('Name,\nA,x').headers).toEqual(['Name', 'Column 2']);
		const big = `Name\n${Array.from({ length: MAX_ROWS + 5 }, (_, i) => `r${i}`).join('\n')}`;
		const t = parseTable(big);
		expect(t.rows).toHaveLength(MAX_ROWS);
		expect(t.truncated).toBe(true);
		expect(parseTable('').headers).toEqual([]);
	});
});

describe('cell converters', () => {
	it('ratings carry their own scale and trailing text', () => {
		expect(parseRatingCell('2.5/5   Really good')).toEqual({ value: 2.5, max: 5, rest: 'Really good' });
		expect(parseRatingCell('8 out of 10')).toEqual({ value: 8, max: 10, rest: '' });
		expect(parseRatingCell('90%')).toEqual({ value: 90, max: 100, rest: '' });
		expect(parseRatingCell('4,5 - lovely')).toEqual({ value: 4.5, max: null, rest: 'lovely' });
		expect(parseRatingCell('★★★½')).toEqual({ value: 3.5, max: 5, rest: '' });
		expect(parseRatingCell('good')).toBeNull();
		expect(parseRatingCell('3rd')).toBeNull();
		expect(parseRatingCell('')).toBeNull();
	});

	it('numbers ignore currency and units', () => {
		expect(parseNumberCell('$9')).toBe(9);
		expect(parseNumberCell('1,299')).toBe(1299);
		expect(parseNumberCell('12 yrs')).toBe(12);
		expect(parseNumberCell('46%')).toBe(46);
		expect(parseNumberCell('12,5')).toBe(12.5);
		expect(parseNumberCell('abc')).toBeNull();
		expect(parseNumberCell('1,2,3')).toBeNull();
	});

	it('yes/no cells', () => {
		expect(parseBooleanCell('✓')).toBe(true);
		expect(parseBooleanCell('Yes')).toBe(true);
		expect(parseBooleanCell('no')).toBe(false);
		expect(parseBooleanCell('')).toBeNull();
		expect(parseBooleanCell('maybe')).toBeUndefined();
	});

	it('dates in the common spellings', () => {
		expect(parseDateCell('2026-10-10')).toBe('2026-10-10');
		expect(parseDateCell('10/9/2026')).toBe('2026-10-09');
		expect(parseDateCell('25/12/2026')).toBe('2026-12-25'); // day first, since 25 can't be a month
		expect(parseDateCell('Oct 10, 2026')).toBe('2026-10-10');
		expect(parseDateCell('10 October 2026')).toBe('2026-10-10');
		expect(parseDateCell('2/30/2026')).toBeNull();
		expect(parseDateCell('soon')).toBeNull();
	});

	it('titles compare without punctuation, case or accents', () => {
		expect(normTitle('Bushmills 10-Year')).toBe(normTitle('bushmills 10 year'));
		expect(normTitle('Beyoncé')).toBe('beyonce');
	});
});

describe('guessing where columns go', () => {
	const table = parseTable(SHEET);
	const mapping = guessMapping(table, whiskey);

	it('maps your whiskey sheet', () => {
		expect(mapping.targets).toEqual([
			'basic:name',
			'field:price', // "Cost" is this list's Price
			'field:distillery',
			'skip', // Location is empty in every row
			'basic:status', // "Daniel Sampled"
			'basic:rating' // "Daniel Rating"
		]);
		expect(validateMapping(mapping, table, whiskey)).toBeNull();
	});

	it('✓ means Tasted, a blank means Wishlist, and the text after a rating becomes notes', () => {
		expect(mapping.statusMap).toEqual({ '': 'wishlist', '✓': 'tasted' });
		expect(mapping.ratingNotes).toBe(true);
	});

	it('turns a column the list lacks into a new field of the right type', () => {
		const t = parseTable(
			'Name\tLocation\tOpened\tVintage\tHave it\nA\tShelf 2\t1/5/2026\t2019\tyes\nB\tBar\t3/6/2026\t2020\tno'
		);
		const m = guessMapping(t, whiskey);
		expect(m.targets).toEqual(['basic:name', 'new:text', 'new:date', 'new:number', 'new:boolean']);
		const fields = planNewFields(t, m, whiskey);
		expect(fields.map((f) => f.key)).toEqual(['location', 'opened', 'vintage', 'have_it']);
	});

	it('only offers details about when it happened if there is a Date column', () => {
		const t = parseTable('Name\tDate\tWhere\tNose\nA\t10/10/2026\tBar\tsmoke');
		const m = guessMapping(t, whiskey);
		expect(m.targets).toEqual(['basic:name', 'log:date', 'log:where', 'logfield:nose']);
		expect(
			validateMapping({ ...m, targets: ['basic:name', 'skip', 'log:where', 'skip'] }, t, whiskey)
		).toMatch(/Date column/);
	});

	it('refuses a mapping that sends two columns to the same place or has no name', () => {
		expect(
			validateMapping({ ...mapping, targets: mapping.targets.map(() => 'basic:name') }, table, whiskey)
		).toMatch(/same place/);
		expect(
			validateMapping({ ...mapping, targets: mapping.targets.map(() => 'skip') }, table, whiskey)
		).toMatch(/names/);
		expect(
			validateMapping(
				{ ...mapping, targets: ['basic:name', 'field:nope', 'skip', 'skip', 'skip', 'skip'] },
				table,
				whiskey
			)
		).toMatch(/no longer exists/);
	});
});

describe('building rows', () => {
	const table = parseTable(SHEET);
	const mapping = guessMapping(table, whiskey);
	const rows = buildRows(table, mapping, whiskey);

	it('rating, status, price and notes', () => {
		const accord = rows[0];
		expect(accord.name).toBe('Accord Stone');
		expect(accord.custom).toEqual({ price: 9 });
		expect(accord.status).toBe('tasted');
		expect(accord.rating).toBe(50); // 2.5 of 5, on this list's 100-point scale
		expect(accord.notes).toBe('Really good');
		expect(rows[2].rating).toBe(60);
		expect(rows[3].rating).toBe(90);
		expect(rows[3].notes).toBe('Madeira finish');
		expect(rows[2].custom).toEqual({ distillery: 'Spot' });
	});

	it('a blank sampled cell is Wishlist, and is flagged so existing items keep their status', () => {
		expect(rows[1].status).toBe('wishlist');
		expect(rows[1].statusFromBlank).toBe(true);
		expect(rows[1].rating).toBeUndefined();
		expect(rows[0].log).toBeUndefined(); // no date column, so no log
	});

	it('converts ratings onto the list scale, and uses the picked scale for bare numbers', () => {
		const stars = { ...whiskey, ratingScale: '5star' as const };
		const rate = (sheet: string, pick?: number) => {
			const t = parseTable(sheet);
			const m = guessMapping(t, stars);
			return buildRows(t, pick ? { ...m, ratingMax: pick } : m, stars).map((r) => r.rating);
		};
		// Bare numbers up to 5 are stars; a cell that states its own scale keeps it
		expect(rate('Name\tRating\nA\t4.5\nB\t3\nC\t8/10')).toEqual([90, 60, 80]);
		// Up to 10 means out of 10, and the 5-star list snaps to its halves
		expect(rate('Name\tRating\nA\t9\nB\t6')).toEqual([90, 60]);
		// Bigger numbers mean out of 100
		expect(rate('Name\tRating\nA\t85\nB\t60')).toEqual([90, 60]);
		// The scale can be picked by hand: "4" is 4 out of 10, not 4 stars
		expect(rate('Name\tRating\nA\t4\nB\t3', 10)).toEqual([40, 30]);
		// Above the scale is left out, not clamped
		const t = parseTable('Name\tRating\nA\t11/10');
		const [row] = buildRows(t, guessMapping(t, stars), stars);
		expect(row.rating).toBeUndefined();
		expect(row.issues[0].message).toMatch(/above 10/);
	});

	it('flags cells it could not use instead of failing the row', () => {
		const t = parseTable('Name\tCost\tAge\nA\tfree\t12 yrs');
		const [row] = buildRows(t, guessMapping(t, whiskey), whiskey);
		expect(row.custom).toEqual({ age: 12 });
		expect(row.issues).toHaveLength(1);
		expect(row.issues[0].col).toBe(1);
	});

	it('creates a log when there is a date', () => {
		const t = parseTable(
			'Name\tDate\tWhere\tNose\tRating\nA\t10/10/2026\tBar\tsmoke\t4/5\nB\t\t\t\t3/5\nC\tsoon\t\t\t'
		);
		const r = buildRows(t, guessMapping(t, whiskey), whiskey);
		expect(r[0].log).toEqual({
			date: '2026-10-10',
			where: 'Bar',
			notes: undefined,
			custom: { nose: 'smoke' }
		});
		expect(r[1].log).toBeUndefined();
		expect(r[2].log).toBeUndefined();
		expect(r[2].issues[0].message).toMatch(/isn't a date/);
	});

	it('pick-one fields reuse existing choices case-insensitively and report new ones', () => {
		const t = parseTable('Name\tType\nA\tbourbon\nB\tRye');
		const r = buildRows(t, guessMapping(t, whiskey), whiskey);
		expect(r[0].custom).toEqual({ type: 'Bourbon' });
		expect(r[0].newChoices).toEqual({});
		expect(r[1].custom).toEqual({ type: 'Rye' });
		expect(r[1].newChoices).toEqual({ type: ['Rye'] });
	});

	it('marks rows that update existing items, repeats and blanks', () => {
		const ctx = { ...whiskey, existing: { [normTitle('Accord Stone')]: 7 } };
		const t = parseTable('Name\nAccord Stone\nNew One\nnew-one\n\n  \nOther');
		const r = buildRows(t, guessMapping(t, ctx), ctx);
		expect(r.map((x) => x.result)).toEqual(['update', 'new', 'duplicate', 'new']);
		expect(r[0].existingId).toBe(7);
		expect(defaultSkipped(r)).toEqual([2]);
		expect(countRows(r, new Set(defaultSkipped(r)))).toEqual({
			rows: 4,
			created: 2,
			updated: 1,
			skipped: 1,
			logs: 0
		});
	});

	it('new fields become ordinary fields before rows are built', () => {
		const t = parseTable('Name\tLocation\nA\tShelf 2');
		const m = guessMapping(t, whiskey);
		const resolved = withNewFields(m, whiskey, planNewFields(t, m, whiskey));
		expect(resolved.mapping.targets).toEqual(['basic:name', 'field:location']);
		const [row] = buildRows(t, resolved.mapping, resolved.ctx);
		expect(row.custom).toEqual({ location: 'Shelf 2' });
	});
});
