import { describe, expect, it } from 'vitest';
import { cleanIcon, firstGrapheme, ICON_GROUPS, searchIcons, suggestIcons } from './icons';

const emojis = (list: { emoji: string }[]) => list.map((i) => i.emoji);

describe('icon catalog', () => {
	it('has no duplicate emoji', () => {
		const all = ICON_GROUPS.flatMap((g) => g.icons.map((i) => i.emoji));
		expect(new Set(all).size).toBe(all.length);
	});

	it('every entry is a single visible character', () => {
		for (const g of ICON_GROUPS) for (const i of g.icons) expect(firstGrapheme(i.emoji)).toBe(i.emoji);
	});
});

describe('searchIcons', () => {
	it('matches word prefixes', () => {
		expect(emojis(searchIcons('whis'))).toContain('🥃');
		expect(emojis(searchIcons('cat'))).toEqual(expect.arrayContaining(['🐈', '🐱']));
	});

	it('requires every word to match', () => {
		expect(emojis(searchIcons('hot sauce'))).toEqual(['🌶️']);
		expect(searchIcons('zzz')).toEqual([]);
	});
});

describe('suggestIcons', () => {
	it('suggests from a list name, plurals included', () => {
		const s = emojis(suggestIcons('Water Bottles'));
		expect(s.slice(0, 3)).toEqual(expect.arrayContaining(['🚰', '🫗', '🧴']));
		expect(s).toContain('💧');
	});

	it('handles other names', () => {
		expect(emojis(suggestIcons('Hot Sauces'))[0]).toBe('🌶️');
		expect(emojis(suggestIcons('Coffee beans'))).toContain('☕');
		expect(emojis(suggestIcons('Hikes'))).toContain('🥾');
		expect(suggestIcons('')).toEqual([]);
	});
});

describe('cleanIcon', () => {
	it('keeps one whole emoji, including joined ones and flags', () => {
		expect(cleanIcon('🥃')).toBe('🥃');
		expect(cleanIcon('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
		expect(cleanIcon('🇯🇵')).toBe('🇯🇵');
		expect(cleanIcon('🍷🧀')).toBe('🍷');
	});

	it('falls back to the box', () => {
		expect(cleanIcon('')).toBe('📦');
		expect(cleanIcon(null)).toBe('📦');
		expect(cleanIcon('   ')).toBe('📦');
	});
});
