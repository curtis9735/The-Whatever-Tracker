import { describe, expect, it } from 'vitest';
import { formatRating, parseRatingInput, toDisplay, toStored } from './ratings';

describe('ratings', () => {
	it('stores every scale as 0–100', () => {
		expect(toStored(4.5, '5star')).toBe(90);
		expect(toStored(8.5, '10')).toBe(85);
		expect(toStored(92, '100')).toBe(92);
		expect(toStored(null, '5star')).toBeNull();
	});

	it('snaps to the scale step and clamps', () => {
		expect(toStored(3.3, '5star')).toBe(70); // 3.5 stars
		expect(toStored(12, '10')).toBe(100);
		expect(toStored(-1, '100')).toBe(0);
	});

	it('round-trips between scales', () => {
		const stored = toStored(4, '5star')!;
		expect(toDisplay(stored, '10')).toBe(8);
		expect(toDisplay(stored, '100')).toBe(80);
		expect(toDisplay(toStored(87, '100'), '5star')).toBe(4.5);
	});

	it('formats for display', () => {
		expect(formatRating(90, '5star')).toBe('4.5★');
		expect(formatRating(85, '10')).toBe('8.5/10');
		expect(formatRating(92, '100')).toBe('92/100');
		expect(formatRating(null, '10')).toBe('');
	});

	it('parses form input', () => {
		expect(parseRatingInput('', '10')).toBeNull();
		expect(parseRatingInput('abc', '10')).toBeNull();
		expect(parseRatingInput('7.5', '10')).toBe(75);
	});
});
