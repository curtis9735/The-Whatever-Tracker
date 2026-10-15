// Journal: date ranges, activity stats and the heatmap. Dates are ISO "YYYY-MM-DD" strings (the
// day something was logged), handled in UTC so no time zone can shift them.

export const RANGES = [
	{ key: 'today', label: 'Today' },
	{ key: 'yesterday', label: 'Yesterday' },
	{ key: 'this-week', label: 'This Week' },
	{ key: 'last-7-days', label: 'Last 7 Days' },
	{ key: 'this-month', label: 'This Month' },
	{ key: 'last-30-days', label: 'Last 30 Days' },
	{ key: 'last-90-days', label: 'Last 90 Days' },
	{ key: 'this-year', label: 'This Year' },
	{ key: 'last-6-months', label: 'Last 6 Months' },
	{ key: 'last-12-months', label: 'Last 12 Months' },
	{ key: 'all-time', label: 'All Time' }
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];
export const DEFAULT_RANGE: RangeKey = 'last-12-months';

export interface DateRange {
	key: RangeKey | 'custom';
	from: string;
	to: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function isIsoDate(s: string | null | undefined): s is string {
	if (!s || !ISO.test(s)) return false;
	const d = toDate(s);
	return !Number.isNaN(d.getTime()) && toIso(d) === s; // "2026-13-40" is not a day; "2026-02-30" rolls over
}

export function addDays(iso: string, n: number) {
	const d = toDate(iso);
	d.setUTCDate(d.getUTCDate() + n);
	return toIso(d);
}

/** Same day n months away, clamped to the month's last day (Mar 31 − 1 month = Feb 28). */
export function addMonths(iso: string, n: number) {
	const [y, m, day] = iso.split('-').map(Number);
	const target = new Date(Date.UTC(y, m - 1 + n, 1));
	const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
	target.setUTCDate(Math.min(day, last));
	return toIso(target);
}

/** 0 = Sunday … 6 = Saturday */
export const weekday = (iso: string) => toDate(iso).getUTCDay();

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The days a range covers. `bounds` are the first and last days anything was logged, for
 * "All Time". A custom range comes as from/to (either order); anything unknown is the default.
 */
export function resolveRange(
	params: { range?: string | null; from?: string | null; to?: string | null },
	today: string,
	bounds: { first: string | null; last: string | null } = { first: null, last: null }
): DateRange {
	if (isIsoDate(params.from) && isIsoDate(params.to)) {
		const [from, to] = params.from <= params.to ? [params.from, params.to] : [params.to, params.from];
		return { key: 'custom', from, to };
	}
	const key = (RANGES.some((r) => r.key === params.range) ? params.range : DEFAULT_RANGE) as RangeKey;
	const r = (from: string, to = today): DateRange => ({ key, from, to });
	switch (key) {
		case 'today':
			return r(today);
		case 'yesterday':
			return r(addDays(today, -1), addDays(today, -1));
		case 'this-week':
			return r(addDays(today, -weekday(today)));
		case 'last-7-days':
			return r(addDays(today, -6));
		case 'this-month':
			return r(`${today.slice(0, 7)}-01`);
		case 'last-30-days':
			return r(addDays(today, -29));
		case 'last-90-days':
			return r(addDays(today, -89));
		case 'this-year':
			return r(`${today.slice(0, 4)}-01-01`);
		case 'last-6-months':
			return r(addDays(addMonths(today, -6), 1));
		case 'all-time': {
			const last = bounds.last && bounds.last > today ? bounds.last : today;
			return r(bounds.first && bounds.first < last ? bounds.first : last, last);
		}
		default:
			return r(addDays(addMonths(today, -12), 1));
	}
}

export function rangeLabel(range: DateRange, format: (iso: string) => string = shortDate) {
	if (range.key !== 'custom') return RANGES.find((r) => r.key === range.key)!.label;
	return range.from === range.to ? format(range.from) : `${format(range.from)} – ${format(range.to)}`;
}

/** "Oct 10, 2026", the same on the server and in the browser */
export function shortDate(iso: string) {
	const [y, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// --- Stats ------------------------------------------------------------------------------

export interface JournalStats {
	total: number;
	/** Days in the range with anything logged */
	activeDays: number;
	/** Day of the week with the most activity, and its share of all activity (0–100) */
	busiestDay: { name: string; percent: number } | null;
	/** Days in a row with something logged, up to today (or yesterday, if today is still empty) */
	currentStreak: number;
	/** Longest run of days in a row within the range */
	longestStreak: number;
}

function longestRun(datesAsc: string[]) {
	let best = 0;
	let run = 0;
	let prev: string | null = null;
	for (const d of datesAsc) {
		run = prev && addDays(prev, 1) === d ? run + 1 : 1;
		best = Math.max(best, run);
		prev = d;
	}
	return best;
}

/**
 * `counts` are activities per day within the range; `activeDays` is every day anything was ever
 * logged (for the current streak, which doesn't depend on the range).
 */
export function journalStats(
	counts: Record<string, number>,
	activeDays: Iterable<string>,
	today: string
): JournalStats {
	const days = Object.keys(counts)
		.filter((d) => counts[d] > 0)
		.sort();
	const total = days.reduce((n, d) => n + counts[d], 0);

	const perWeekday = Array<number>(7).fill(0);
	for (const d of days) perWeekday[weekday(d)] += counts[d];
	const top = perWeekday.indexOf(Math.max(...perWeekday));
	const busiestDay = total
		? { name: WEEKDAYS[top], percent: Math.round((perWeekday[top] / total) * 100) }
		: null;

	const active = new Set(activeDays);
	let day = active.has(today) ? today : addDays(today, -1);
	let currentStreak = 0;
	while (active.has(day)) {
		currentStreak++;
		day = addDays(day, -1);
	}

	return { total, activeDays: days.length, busiestDay, currentStreak, longestStreak: longestRun(days) };
}

// --- Heatmap ----------------------------------------------------------------------------

export interface HeatCell {
	date: string;
	count: number;
	/** 0 = nothing, 1–4 = more and more */
	level: number;
	inRange: boolean;
}

export const MAX_HEATMAP_WEEKS = 265; // about five years

/** Shade for a day: the count itself up to 4, scaled to the busiest day beyond that. */
export function heatLevel(count: number, max: number) {
	if (count <= 0) return 0;
	if (max <= 4) return Math.min(count, 4);
	return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

/**
 * Week columns (Sunday on top) covering the range, plus where each month's label goes.
 * Very long ranges keep their most recent five years.
 */
export function heatmap(range: DateRange, counts: Record<string, number>) {
	let start = addDays(range.from, -weekday(range.from));
	const end = addDays(range.to, 6 - weekday(range.to));
	const earliest = addDays(end, -(MAX_HEATMAP_WEEKS * 7 - 1));
	const truncated = start < earliest;
	if (truncated) start = earliest;

	const max = Math.max(0, ...Object.values(counts));
	const weeks: HeatCell[][] = [];
	for (let d = start; d <= end;) {
		const week: HeatCell[] = [];
		for (let i = 0; i < 7; i++, d = addDays(d, 1)) {
			const count = counts[d] ?? 0;
			week.push({ date: d, count, level: heatLevel(count, max), inRange: d >= range.from && d <= range.to });
		}
		weeks.push(week);
	}

	// A month's label sits over the week its 1st falls in; the first week names the month the range starts in
	const monthOf = (c: HeatCell) => MONTHS[Number(c.date.slice(5, 7)) - 1];
	const months: { col: number; label: string }[] = [];
	weeks.forEach((week, col) => {
		const firstOfMonth = week.find((c) => c.inRange && c.date.endsWith('-01'));
		const opening = col === 0 ? week.find((c) => c.inRange) : undefined;
		const cell = firstOfMonth ?? opening;
		if (!cell) return;
		const prev = months.at(-1);
		if (prev && col - prev.col < 2) {
			// Labels would overlap (a range starting late in a month): the month that begins wins
			if (prev.col === 0 && firstOfMonth) months.pop();
			else return;
		}
		months.push({ col, label: monthOf(cell) });
	});

	return { weeks, months, truncated };
}
