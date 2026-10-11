import { describe, expect, it } from 'vitest';
import { buildFtsQuery } from './local';

describe('buildFtsQuery', () => {
	it('quotes each word as a prefix term', () => {
		expect(buildFtsQuery('dune part')).toBe('"dune"* "part"*');
	});

	it('strips punctuation so user input cannot inject FTS syntax', () => {
		expect(buildFtsQuery('AND OR "NEAR" (x) -y*')).toBe('"AND"* "OR"* "NEAR"* "x"* "y"*');
	});

	it('returns null for empty input', () => {
		expect(buildFtsQuery('   ')).toBeNull();
		expect(buildFtsQuery('!!!')).toBeNull();
	});
});
