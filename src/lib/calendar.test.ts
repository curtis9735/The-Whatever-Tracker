import { describe, expect, it } from 'vitest';
import { monthGrid, monthLabel, parseMonth, releaseLabel, shiftMonth } from './calendar';

describe('calendar months', () => {
	it('reads ?month= or falls back to the current month', () => {
		expect(parseMonth('2026-10', '2026-03-05')).toBe('2026-10');
		expect(parseMonth('2026-13', '2026-03-05')).toBe('2026-03');
		expect(parseMonth(null, '2026-03-05')).toBe('2026-03');
	});

	it('steps between months and years', () => {
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(monthLabel('2026-10')).toBe('October 2026');
	});

	it('lays out whole weeks, Sunday first', () => {
		// October 2026 starts on a Thursday and ends on a Saturday
		const g = monthGrid('2026-10');
		expect(g.first).toBe('2026-10-01');
		expect(g.last).toBe('2026-10-31');
		expect(g.start).toBe('2026-09-27');
		expect(g.end).toBe('2026-10-31');
		expect(g.weeks).toHaveLength(5);
		expect(g.weeks.every((w) => w.length === 7)).toBe(true);
		expect(monthGrid('2027-02').weeks.flat()).toContain('2027-02-28');
	});

	it('labels releases', () => {
		expect(releaseLabel({ kind: 'episode', season: 11, episode: 1 })).toBe('S11 E1');
		expect(releaseLabel({ kind: 'episode', season: 0, episode: 3 })).toBe('Special 3');
		expect(releaseLabel({ kind: 'movie', season: null, episode: null })).toBe('Movie release');
		expect(releaseLabel({ kind: 'game', season: null, episode: null })).toBe('Game release');
	});
});
