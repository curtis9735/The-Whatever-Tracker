// Reads a table pasted from a spreadsheet (tab-separated) or a CSV file (comma or semicolon).
// Client-safe: the import page previews with it, and the server re-reads with it on import.

export const MAX_ROWS = 5000;

export interface Table {
	headers: string[];
	rows: string[][];
	/** More data rows than MAX_ROWS were given; only the first MAX_ROWS are kept */
	truncated: boolean;
}

/** Tab when pasted from a spreadsheet; otherwise whichever of comma or semicolon the header row uses more. */
export function detectDelimiter(text: string) {
	const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
	if (firstLine.includes('\t')) return '\t';
	const count = (ch: string) => firstLine.split(ch).length - 1;
	return count(';') > count(',') ? ';' : ',';
}

/** RFC 4180 records: quoted fields may hold the delimiter, newlines and "" for a quote. */
function records(text: string, delimiter: string) {
	const out: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch !== '"') field += ch;
			else if (text[i + 1] === '"') {
				field += '"';
				i++;
			} else quoted = false;
		} else if (ch === '"' && field === '') {
			quoted = true;
		} else if (ch === delimiter) {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			out.push(row);
			row = [];
			field = '';
		} else {
			field += ch;
		}
	}
	if (field !== '' || row.length) {
		row.push(field);
		out.push(row);
	}
	return out;
}

export function parseTable(text: string): Table {
	const clean = text.replace(/^﻿/, '');
	const all = records(clean, detectDelimiter(clean)).filter((r) => r.some((c) => c.trim() !== ''));
	if (!all.length) return { headers: [], rows: [], truncated: false };

	// Drop columns that are empty all the way down at the right edge (spreadsheets pad rows)
	let width = Math.max(...all.map((r) => r.length));
	while (width > 0 && all.every((r) => !(r[width - 1] ?? '').trim())) width--;
	const [head, ...body] = all.map((r) => Array.from({ length: width }, (_, j) => (r[j] ?? '').trim()));

	return {
		headers: head.map((h, j) => h || `Column ${j + 1}`),
		rows: body.slice(0, MAX_ROWS),
		truncated: body.length > MAX_ROWS
	};
}
