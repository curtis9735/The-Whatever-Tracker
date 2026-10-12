import { describe, expect, it, vi } from 'vitest';
import { isFinished } from '$lib/status';
import type { StatusDef } from '$lib/types';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
const { firstLogDate } = await import('./forms');

const movieStatuses: StatusDef[] = [
	{ key: 'planning', label: 'Planning', group: 'planned' },
	{ key: 'watching', label: 'Watching', group: 'active' },
	{ key: 'completed', label: 'Completed', group: 'done' },
	{ key: 'dropped', label: 'Dropped', group: 'dropped' }
];

const withDate = (date: string | null) => {
	const fd = new FormData();
	if (date !== null) fd.set('log_date', date);
	return fd;
};

describe('first log when adding an item', () => {
	it('only finished statuses count as "it already happened"', () => {
		expect(isFinished(movieStatuses, 'completed')).toBe(true);
		expect(isFinished(movieStatuses, 'planning')).toBe(false);
		expect(isFinished(movieStatuses, 'watching')).toBe(false);
		expect(isFinished(movieStatuses, 'dropped')).toBe(false);
		expect(isFinished(movieStatuses, null)).toBe(false);
	});

	it('records the date for a finished status', () => {
		expect(firstLogDate(withDate('2026-10-11'), movieStatuses, 'completed')).toBe('2026-10-11');
	});

	it('skips when the date was cleared, missing or invalid', () => {
		expect(firstLogDate(withDate(''), movieStatuses, 'completed')).toBeNull();
		expect(firstLogDate(withDate(null), movieStatuses, 'completed')).toBeNull();
		expect(firstLogDate(withDate('11/10/2026'), movieStatuses, 'completed')).toBeNull();
	});

	it('never logs planned or in-progress additions, even if a date is sent', () => {
		expect(firstLogDate(withDate('2026-10-11'), movieStatuses, 'planning')).toBeNull();
		expect(firstLogDate(withDate('2026-10-11'), movieStatuses, 'watching')).toBeNull();
	});
});
