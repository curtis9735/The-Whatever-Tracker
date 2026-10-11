import { describe, expect, it } from 'vitest';
import { fieldKey, formatFieldValue, parseCustomFields, slugify } from './fields';
import type { FieldDef } from './types';

const def = (key: string, type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({
	key,
	label: key,
	type,
	scope: 'item',
	options: [],
	unit: null,
	showOnCard: false,
	...extra
});

function form(entries: [string, string][]) {
	const fd = new FormData();
	for (const [k, v] of entries) fd.append(k, v);
	return fd;
}

describe('parseCustomFields', () => {
	const defs = [
		def('distillery', 'text'),
		def('abv', 'number'),
		def('milk', 'multiselect', { options: ['Cow', 'Goat'] }),
		def('peated', 'boolean'),
		def('bottled', 'date'),
		def('site', 'url')
	];

	it('converts and omits blanks', () => {
		const { values, error } = parseCustomFields(
			defs,
			form([
				['cf_distillery', '  Lagavulin '],
				['cf_abv', '43'],
				['cf_milk', 'Cow'],
				['cf_milk', 'Goat'],
				['cf_milk', 'Cow'],
				['cf_peated', 'on'],
				['cf_bottled', ''],
				['cf_site', '']
			]),
			'cf_'
		);
		expect(error).toBeNull();
		expect(values).toEqual({ distillery: 'Lagavulin', abv: 43, milk: ['Cow', 'Goat'], peated: true });
	});

	it('reports the first invalid field', () => {
		expect(parseCustomFields(defs, form([['cf_abv', 'strong']]), 'cf_').error).toMatch(
			/abv must be a number/
		);
		expect(parseCustomFields(defs, form([['cf_site', 'javascript:alert(1)']]), 'cf_').error).toBeTruthy();
		expect(parseCustomFields(defs, form([['cf_bottled', '12/03/2020']]), 'cf_').error).toMatch(/date/);
	});

	it('unchecked booleans are simply absent', () => {
		expect(parseCustomFields([def('peated', 'boolean')], form([]), 'cf_').values).toEqual({});
	});
});

describe('helpers', () => {
	it('formats values', () => {
		expect(formatFieldValue({ type: 'number', unit: '%' }, 46)).toBe('46 %');
		expect(formatFieldValue({ type: 'multiselect', unit: null }, ['Cow', 'Goat'])).toBe('Cow, Goat');
		expect(formatFieldValue({ type: 'boolean', unit: null }, true)).toBe('Yes');
	});

	it('slugifies names and keys', () => {
		expect(slugify('Hot Sauces 🌶️')).toBe('hot-sauces');
		expect(slugify('Crème brûlée')).toBe('creme-brulee');
		expect(fieldKey('Where we met')).toBe('where_we_met');
	});
});
