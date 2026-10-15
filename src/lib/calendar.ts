// Calendar of upcoming releases: month navigation and the month grid. Client-safe.
import { addDays, addMonths, weekday } from './journal';

/** Kinds of list whose items have release dates (TMDB shows and movies, IGDB games) */
export const RELEASE_KINDS = ['tmdb:tv', 'tmdb:movie', 'igdb:game'];

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

/** "2026-10" from ?month=, or the month `today` is in */
export function parseMonth(param: string | null | undefined, today: string) {
	if (param && /^\d{4}-(0[1-9]|1[0-2])$/.test(param)) return param;
	return today.slice(0, 7);
}

export const shiftMonth = (month: string, n: number) => addMonths(`${month}-01`, n).slice(0, 7);

export function monthLabel(month: string) {
	const [y, m] = month.split('-').map(Number);
	return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The weeks (Sunday first) a month view shows, including the days around the month that fill them. */
export function monthGrid(month: string) {
	const first = `${month}-01`;
	const last = addDays(addMonths(first, 1), -1);
	const start = addDays(first, -weekday(first));
	const end = addDays(last, 6 - weekday(last));
	const weeks: string[][] = [];
	for (let d = start; d <= end;) {
		const week: string[] = [];
		for (let i = 0; i < 7; i++, d = addDays(d, 1)) week.push(d);
		weeks.push(week);
	}
	return { first, last, start, end, weeks };
}

/** "S11 E1", "Movie release", "Game release" */
export function releaseLabel(r: { kind: string; season: number | null; episode: number | null }) {
	if (r.kind === 'episode') {
		if (r.season === 0) return `Special${r.episode ? ` ${r.episode}` : ''}`;
		return [r.season !== null ? `S${r.season}` : '', r.episode !== null ? `E${r.episode}` : '']
			.filter(Boolean)
			.join(' ');
	}
	return r.kind === 'movie' ? 'Movie release' : 'Game release';
}
