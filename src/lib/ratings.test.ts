import { describe, expect, it } from 'vitest';
import { formatRating, parseRatingInput, toDisplay, toStored } from './ratings';

describe('ratings', () => {
	it('are whole numbers out of 10, stored as tens', () => {
		expect(toStored(8)).toBe(80);
		expect(toStored(10)).toBe(100);
		expect(toStored(1)).toBe(10);
		expect(toStored(null)).toBeNull();
		expect(toStored(undefined)).toBeNull();
	});

	it('round to a whole number and clamp', () => {
		expect(toStored(7.4)).toBe(70);
		expect(toStored(7.5)).toBe(80);
		expect(toStored(12)).toBe(100);
		expect(toStored(-1)).toBe(0);
	});

	it('read back what was stored', () => {
		expect(toDisplay(toStored(6))).toBe(6);
		expect(toDisplay(85)).toBe(9); // an old value that wasn't a multiple of ten
		expect(toDisplay(null)).toBeNull();
	});

	it('format for display', () => {
		expect(formatRating(90)).toBe('9/10');
		expect(formatRating(0)).toBe('0/10');
		expect(formatRating(null)).toBe('');
	});

	it('parse form input', () => {
		expect(parseRatingInput('')).toBeNull();
		expect(parseRatingInput('abc')).toBeNull();
		expect(parseRatingInput('7')).toBe(70);
		expect(parseRatingInput('7.5')).toBe(80);
	});
});
