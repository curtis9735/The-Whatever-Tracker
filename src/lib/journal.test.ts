import { describe, expect, it } from 'vitest';
import {
	addDays,
	addMonths,
	heatLevel,
	heatmap,
	isIsoDate,
	journalStats,
	rangeLabel,
	resolveRange,
	weekday
} from './journal';

const TODAY = '2026-10-14'; // a Wednesday

describe('dates', () => {
	it('step by days and months', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
		expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
		expect(addMonths('2026-10-14', -12)).toBe('2025-10-14');
		expect(weekday(TODAY)).toBe(3);
		expect(isIsoDate('2026-02-30')).toBe(false);
		expect(isIsoDate('2026-02-28')).toBe(true);
		expect(isIsoDate('10/14/2026')).toBe(false);
	});
});

describe('ranges', () => {
	const range = (key: string) => resolveRange({ range: key }, TODAY);

	it('cover the expected days', () => {
		expect(range('today')).toMatchObject({ from: TODAY, to: TODAY });
		expect(range('yesterday')).toMatchObject({ from: '2026-10-13', to: '2026-10-13' });
		expect(range('this-week')).toMatchObject({ from: '2026-10-11', to: TODAY }); // weeks start on Sunday
		expect(range('last-7-days')).toMatchObject({ from: '2026-10-08', to: TODAY });
		expect(range('this-month')).toMatchObject({ from: '2026-10-01', to: TODAY });
		expect(range('last-30-days')).toMatchObject({ from: '2026-09-15', to: TODAY });
		expect(range('last-90-days')).toMatchObject({ from: '2026-07-17', to: TODAY });
		expect(range('this-year')).toMatchObject({ from: '2026-01-01', to: TODAY });
		expect(range('last-6-months')).toMatchObject({ from: '2026-04-15', to: TODAY });
		expect(range('last-12-months')).toMatchObject({ from: '2025-10-15', to: TODAY });
	});

	it('default to the last 12 months', () => {
		expect(resolveRange({}, TODAY)).toMatchObject({ key: 'last-12-months', from: '2025-10-15' });
		expect(resolveRange({ range: 'nonsense' }, TODAY).key).toBe('last-12-months');
	});

	it('"All Time" spans everything logged, including anything logged ahead', () => {
		expect(
			resolveRange({ range: 'all-time' }, TODAY, { first: '2019-05-02', last: '2026-10-10' })
		).toMatchObject({
			from: '2019-05-02',
			to: TODAY
		});
		expect(resolveRange({ range: 'all-time' }, TODAY, { first: '2020-01-01', last: '2026-12-31' }).to).toBe(
			'2026-12-31'
		);
		expect(resolveRange({ range: 'all-time' }, TODAY)).toMatchObject({ from: TODAY, to: TODAY });
	});

	it('custom ranges accept either order and ignore bad dates', () => {
		expect(resolveRange({ from: '2026-10-10', to: '2026-09-01' }, TODAY)).toEqual({
			key: 'custom',
			from: '2026-09-01',
			to: '2026-10-10'
		});
		expect(resolveRange({ from: '2026-13-40', to: '2026-09-01', range: 'today' }, TODAY).key).toBe('today');
	});

	it('have readable labels', () => {
		expect(rangeLabel(range('last-90-days'))).toBe('Last 90 Days');
		expect(rangeLabel({ key: 'custom', from: '2026-09-01', to: '2026-10-10' })).toBe(
			'Sep 1, 2026 – Oct 10, 2026'
		);
		expect(rangeLabel({ key: 'custom', from: '2026-10-10', to: '2026-10-10' })).toBe('Oct 10, 2026');
	});
});

describe('stats', () => {
	it('count activity, find the busiest weekday and the longest run', () => {
		const counts = { '2026-10-04': 2, '2026-10-05': 1, '2026-10-06': 1, '2026-10-11': 3, '2026-10-12': 0 };
		const s = journalStats(counts, Object.keys(counts), TODAY);
		expect(s.total).toBe(7);
		expect(s.activeDays).toBe(4); // Oct 12 had a zero count
		expect(s.busiestDay).toEqual({ name: 'Sunday', percent: 71 }); // Oct 4 and 11 are Sundays: 5 of 7
		expect(s.longestStreak).toBe(3); // Oct 4–6
	});

	it('the current streak runs back from today, or from yesterday if today is still empty', () => {
		const days = ['2026-10-11', '2026-10-12', '2026-10-13'];
		expect(journalStats({}, days, TODAY).currentStreak).toBe(3);
		expect(journalStats({}, [...days, TODAY], TODAY).currentStreak).toBe(4);
		expect(journalStats({}, ['2026-10-11', '2026-10-12'], TODAY).currentStreak).toBe(0);
	});

	it('handle an empty range', () => {
		expect(journalStats({}, [], TODAY)).toEqual({
			total: 0,
			activeDays: 0,
			busiestDay: null,
			currentStreak: 0,
			longestStreak: 0
		});
	});
});

describe('heatmap', () => {
	it('shades by count, and relative to the busiest day once days get busy', () => {
		expect([0, 1, 2, 3, 4, 9].map((n) => heatLevel(n, 4))).toEqual([0, 1, 2, 3, 4, 4]);
		expect([1, 5, 10, 20].map((n) => heatLevel(n, 20))).toEqual([1, 1, 2, 4]);
	});

	it('lays out whole weeks, Sunday first, marking days outside the range', () => {
		const range = resolveRange({ range: 'last-30-days' }, TODAY);
		const { weeks, months } = heatmap(range, { '2026-10-10': 2 });
		expect(weeks.every((w) => w.length === 7)).toBe(true);
		expect(weekday(weeks[0][0].date)).toBe(0);
		expect(weeks[0][0].date <= range.from).toBe(true);
		const cells = weeks.flat();
		expect(cells.filter((c) => c.inRange)).toHaveLength(30);
		expect(cells.find((c) => c.date === '2026-10-10')).toMatchObject({ count: 2, level: 2, inRange: true });
		expect(cells.find((c) => c.date === '2026-10-15')!.inRange).toBe(false);
		expect(months.map((m) => m.label)).toEqual(['Sep', 'Oct']);
	});

	it('labels each month once over a year', () => {
		const { months, truncated } = heatmap(resolveRange({}, TODAY), {});
		expect(months.map((m) => m.label)).toEqual([
			'Oct',
			'Nov',
			'Dec',
			'Jan',
			'Feb',
			'Mar',
			'Apr',
			'May',
			'Jun',
			'Jul',
			'Aug',
			'Sep',
			'Oct'
		]);
		expect(truncated).toBe(false);
	});

	it('keeps the most recent five years of a very long range', () => {
		const { weeks, truncated } = heatmap({ key: 'all-time', from: '2001-01-01', to: TODAY }, {});
		expect(truncated).toBe(true);
		expect(weeks.at(-1)!.some((c) => c.date === TODAY)).toBe(true);
		expect(weeks.length).toBeLessThanOrEqual(265);
	});
});
