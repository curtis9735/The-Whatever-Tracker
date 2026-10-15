import { describe, expect, it } from 'vitest';
import { foldLine, icsCalendar, icsText } from './ics';

describe('calendar file', () => {
	it('escapes text', () => {
		expect(icsText('Love, Death; Robots\\Two\nLines')).toBe('Love\\, Death\\; Robots\\\\Two\\nLines');
	});

	it('folds long lines without splitting characters', () => {
		const line = `SUMMARY:${'é'.repeat(60)}`; // 8 + 120 bytes
		const folded = foldLine(line);
		const parts = folded.split('\r\n');
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(75);
		expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
		expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
		expect(foldLine('SHORT:line')).toBe('SHORT:line');
	});

	it('writes all-day events', () => {
		const ics = icsCalendar(
			'Releases',
			[{ uid: 'release-1@host', date: '2026-10-31', summary: 'Ted Lasso S4 E10', description: 'Finale' }],
			new Date('2026-10-14T12:00:00Z')
		);
		expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
		expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(ics).toContain('DTSTART;VALUE=DATE:20261031');
		expect(ics).toContain('DTEND;VALUE=DATE:20261101'); // the day after, across the month end
		expect(ics).toContain('DTSTAMP:20261014T120000Z');
		expect(ics).toContain('SUMMARY:Ted Lasso S4 E10');
		expect(ics.split('BEGIN:VEVENT')).toHaveLength(2);
	});
});
