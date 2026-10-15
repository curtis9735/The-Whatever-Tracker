// iCalendar (.ics) for the Calendar's download: all-day events, one per release.

export interface IcsEvent {
	uid: string;
	/** YYYY-MM-DD */
	date: string;
	summary: string;
	description?: string;
}

/** Commas, semicolons, backslashes and line breaks are escaped in text values (RFC 5545 3.3.11). */
export function icsText(s: string) {
	return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 bytes continue on the next line after a space, never splitting a character. */
export function foldLine(line: string) {
	const parts: string[] = [];
	let current = '';
	let bytes = 0;
	for (const ch of line) {
		const size = Buffer.byteLength(ch);
		const limit = parts.length ? 74 : 75; // continuation lines start with a space
		if (bytes + size > limit) {
			parts.push(current);
			current = '';
			bytes = 0;
		}
		current += ch;
		bytes += size;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

const compact = (iso: string) => iso.replace(/-/g, '');

function nextDay(iso: string) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

export function icsCalendar(name: string, events: IcsEvent[], now = new Date()) {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//The Whatever Tracker//Releases//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${icsText(name)}`
	];
	for (const e of events) {
		lines.push(
			'BEGIN:VEVENT',
			`UID:${e.uid}`,
			`DTSTAMP:${stamp}`,
			`DTSTART;VALUE=DATE:${compact(e.date)}`,
			`DTEND;VALUE=DATE:${compact(nextDay(e.date))}`,
			`SUMMARY:${icsText(e.summary)}`,
			...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
			'TRANSP:TRANSPARENT',
			'END:VEVENT'
		);
	}
	lines.push('END:VCALENDAR');
	return lines.map(foldLine).join('\r\n') + '\r\n';
}
