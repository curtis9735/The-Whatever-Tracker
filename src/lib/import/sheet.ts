// Spreadsheet import: guesses where each column goes, converts cells, and builds the rows to save.
// Client-safe. The import page previews with it, and the server runs the same code again on import
// (it never trusts what the browser worked out).

import { fieldKey } from '../fields';
import { formatRating, RATING_MAX, toStored } from '../ratings';
import type { FieldDef, FieldType, StatusDef } from '../types';
import type { Table } from './table';

// --- Mapping ----------------------------------------------------------------------------
//
// Each column's target is a string, so a mapping is plain JSON:
//   skip | basic:name|subtitle|notes|barcode|status|rating|tags|image
//   field:<key>  logfield:<key>  log:date|where|notes  new:<type>   (a new item field named after the column)

export const BASIC_TARGETS = [
	'name',
	'subtitle',
	'notes',
	'barcode',
	'status',
	'rating',
	'tags',
	'image'
] as const;
export const LOG_TARGETS = ['date', 'where', 'notes'] as const;
export const NEW_FIELD_TYPES: FieldType[] = ['text', 'longtext', 'number', 'date', 'boolean', 'url'];

export interface ImportMapping {
	/** One target per column */
	targets: string[];
	/** What each distinct cell of the status column means ("" is a blank cell) -> status key, or "" for none */
	statusMap: Record<string, string>;
	/** Scale of ratings that don't carry their own ("4.5" rather than "4.5/5"); null = work it out */
	ratingMax: number | null;
	/** Text after the rating ("2.5/5  Really good") goes into notes */
	ratingNotes: boolean;
}

export interface ListContext {
	name: string;
	statuses: StatusDef[];
	itemFields: FieldDef[];
	logFields: FieldDef[];
	/** Normalized titles already in the list -> item id */
	existing: Record<string, number>;
}

export function parseTarget(t: string): { kind: string; arg: string } {
	const i = t.indexOf(':');
	return i === -1 ? { kind: t, arg: '' } : { kind: t.slice(0, i), arg: t.slice(i + 1) };
}

// --- Text helpers -----------------------------------------------------------------------

/** "Bushmills 10-Year" and "bushmills 10 year" compare equal; so do "Beyoncé" and "Beyonce". */
export function normTitle(s: string) {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

const words = (s: string) => new Set(normTitle(s).split(' ').filter(Boolean));
const hasWord = (set: Set<string>, list: string[]) => list.some((w) => set.has(w) || set.has(`${w}s`));

// --- Cell converters --------------------------------------------------------------------

const num = (s: string) => Number(s.replace(',', '.'));
const tidy = (s: string) => s.replace(/^[\s\-–—:;,.|)\]]+/, '').trim();

export interface RatingCell {
	value: number;
	/** The scale the cell states ("/5", "out of 10", "%", stars), if it does */
	max: number | null;
	/** Whatever followed the rating */
	rest: string;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const FRACTION = new RegExp(`^${NUM}\\s*(?:/|out of|of)\\s*${NUM}(?![\\p{L}\\p{N}])(.*)$`, 'isu');
const PERCENT = new RegExp(`^${NUM}\\s*%(.*)$`, 'su');
const PLAIN = new RegExp(`^${NUM}(?![\\p{L}\\p{N}/])(.*)$`, 'su');

/** "4.5", "2.5/5  Really good", "8 out of 10", "90%", "★★★½" */
export function parseRatingCell(raw: string): RatingCell | null {
	const s = raw.trim();
	if (!s) return null;
	const stars = s.match(/^([★⭐]+)(½)?(.*)$/su);
	if (stars) return { value: [...stars[1]].length + (stars[2] ? 0.5 : 0), max: 5, rest: tidy(stars[3]) };
	const frac = s.match(FRACTION);
	if (frac) {
		const max = num(frac[2]);
		return max > 0 ? { value: num(frac[1]), max, rest: tidy(frac[3]) } : null;
	}
	const pct = s.match(PERCENT);
	if (pct) return { value: num(pct[1]), max: 100, rest: tidy(pct[2]) };
	const plain = s.match(PLAIN);
	if (plain) return { value: num(plain[1]), max: null, rest: tidy(plain[2]) };
	return null;
}

/** "$9", "1,299", "12 yrs", "46%": the number in it, or null. */
export function parseNumberCell(raw: string): number | null {
	// Currency signs and spaces may come first, but not words ("Shelf 2" isn't a number)
	const m = raw.trim().match(/^[^\d\p{L}-]*(-?\d[\d.,]*)\s*[^\d]*$/u);
	if (!m) return null;
	let n = m[1];
	if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, '');
	else if (/^-?\d+,\d{1,2}$/.test(n)) n = n.replace(',', '.');
	else if (/,/.test(n)) return null;
	const v = Number(n);
	return Number.isFinite(v) ? v : null;
}

const TRUE_WORDS = new Set(['✓', '✔', '✔️', '☑', '☑️', '✅', 'x', 'yes', 'y', 'true', '1', 'checked']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', '✗', '✘', '❌']);
export const isTruthyCell = (s: string) => TRUE_WORDS.has(s.trim().toLowerCase());

/** true / false, null for a blank cell, undefined when it isn't a yes/no at all */
export function parseBooleanCell(raw: string): boolean | null | undefined {
	const s = raw.trim().toLowerCase();
	if (!s) return null;
	if (TRUE_WORDS.has(s)) return true;
	if (FALSE_WORDS.has(s)) return false;
	return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number) {
	const t = new Date(Date.UTC(y, m - 1, d));
	if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
	return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2026-10-10", "10/10/2026" (US order unless the first number is above 12), "Oct 10, 2026", "10 Oct 2026" */
export function parseDateCell(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
	if (m) return isoDate(+m[1], +m[2], +m[3]);
	m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
	if (m) {
		let [a, b] = [+m[1], +m[2]];
		const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
		if (a > 12) [a, b] = [b, a]; // day first
		return isoDate(y, a, b);
	}
	m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
	if (m) {
		const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
		return mi === -1 ? null : isoDate(+m[3], mi + 1, +m[2]);
	}
	m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
	if (m) {
		const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
		return mi === -1 ? null : isoDate(+m[3], mi + 1, +m[1]);
	}
	return null;
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

// --- Guessing ---------------------------------------------------------------------------

const column = (table: Table, j: number) => table.rows.map((r) => r[j] ?? '');
const filled = (values: string[]) => values.filter((v) => v.trim() !== '');

/** The field type that fits what's in a column (for columns that become a new field). */
export function guessFieldType(values: string[]): FieldType {
	const v = filled(values);
	if (!v.length) return 'text';
	if (v.every((x) => /^(✓|✔|✔️|☑|☑️|✅|x|yes|no|y|n|true|false)$/i.test(x.trim()))) return 'boolean';
	if (v.every((x) => parseNumberCell(x) !== null)) return 'number';
	if (v.every((x) => parseDateCell(x) !== null)) return 'date';
	if (v.every(isUrl)) return 'url';
	if (v.some((x) => x.length > 120)) return 'longtext';
	return 'text';
}

const DONE_PREFERENCE = [
	'tasted',
	'sampled',
	'seen',
	'played',
	'watched',
	'read',
	'completed',
	'tried',
	'finished'
];

/** The "I've done this" status that fits the list best: Tasted for whiskey, Seen for concerts… */
export function doneStatus(statuses: StatusDef[]) {
	const done = statuses.filter((s) => s.group === 'done');
	for (const w of DONE_PREFERENCE) {
		const m = done.find((s) => normTitle(s.label) === w || s.key === w);
		if (m) return m.key;
	}
	return done[0]?.key ?? statuses[0]?.key ?? '';
}

export function plannedStatus(statuses: StatusDef[]) {
	return (statuses.find((s) => s.group === 'planned') ?? statuses[0])?.key ?? '';
}

export const statusCellKey = (cell: string) => cell.trim().toLowerCase();

/** What one status-column cell most likely means. */
export function guessStatus(cell: string, statuses: StatusDef[]) {
	const k = statusCellKey(cell);
	const named = statuses.find((s) => s.key === k || s.label.toLowerCase() === k);
	if (named) return named.key;
	if (isTruthyCell(k)) return doneStatus(statuses);
	return plannedStatus(statuses); // blank, "no", or something we can't tell
}

const MAX_STATUS_VALUES = 30;

export function guessStatusMap(values: string[], statuses: StatusDef[]) {
	const map: Record<string, string> = {};
	for (const v of ['', ...values]) {
		const k = statusCellKey(v);
		if (!(k in map) && Object.keys(map).length < MAX_STATUS_VALUES) map[k] = guessStatus(k, statuses);
	}
	return map;
}

/** Distinct cells of the status column, blank first, as they'll be asked about. */
export function distinctStatusCells(values: string[]) {
	const seen = new Set<string>(['']);
	for (const v of values) seen.add(statusCellKey(v));
	return [...seen].slice(0, MAX_STATUS_VALUES);
}

export function guessRatingMax(values: string[]): number {
	let biggest = 0;
	for (const v of values) {
		const r = parseRatingCell(v);
		if (r && r.max === null) biggest = Math.max(biggest, r.value);
	}
	return biggest <= 5 ? 5 : biggest <= 10 ? 10 : 100;
}

const SYNONYMS = {
	date: ['date', 'when'],
	where: ['location', 'where', 'venue', 'place', 'city'],
	name: ['name', 'title'],
	rating: ['rating', 'score', 'stars', 'rate', 'rated'],
	status: [
		'status',
		'sampled',
		'tried',
		'tasted',
		'seen',
		'played',
		'owned',
		'watched',
		'completed',
		'finished',
		'done'
	],
	tags: ['tags', 'tag', 'labels'],
	subtitle: ['subtitle'],
	notes: ['notes', 'note', 'comments', 'comment', 'review', 'thoughts', 'description'],
	barcode: ['barcode', 'upc', 'ean', 'isbn'],
	image: ['photo', 'image', 'picture', 'cover', 'poster', 'img'],
	price: ['cost', 'price', 'paid', 'msrp']
};

export function guessMapping(table: Table, ctx: ListContext): ImportMapping {
	const n = table.headers.length;
	const targets: (string | null)[] = Array(n).fill(null);
	const taken = new Set<string>();
	const hs = table.headers.map(words);
	const hasDate = hs.some((w) => hasWord(w, SYNONYMS.date));

	const claim = (j: number, target: string) => {
		if (targets[j] || taken.has(target)) return false;
		taken.add(target);
		targets[j] = target;
		return true;
	};
	const sameKey = (f: FieldDef, ...names: string[]) =>
		names.some((x) => normTitle(f.label) === x || normTitle(f.key) === x);

	// 1. A column named exactly like one of the list's fields
	for (let j = 0; j < n; j++) {
		const h = normTitle(table.headers[j]);
		const item = ctx.itemFields.find((f) => sameKey(f, h));
		if (item) claim(j, `field:${item.key}`);
		else if (hasDate) {
			const log = ctx.logFields.find((f) => sameKey(f, h));
			if (log) claim(j, `logfield:${log.key}`);
		}
	}

	// 2. Common names for things every list has, then fields named inside the header
	for (let j = 0; j < n; j++) {
		if (targets[j]) continue;
		const w = hs[j];
		const values = column(table, j);
		const urls = filled(values);
		const looksLikeLinks = urls.length > 0 && urls.filter(isUrl).length >= urls.length / 2;

		if (hasWord(w, SYNONYMS.date) && claim(j, 'log:date')) continue;
		if (hasDate && hasWord(w, SYNONYMS.where) && claim(j, 'log:where')) continue;
		if (hasWord(w, SYNONYMS.name) && claim(j, 'basic:name')) continue;
		if (hasWord(w, SYNONYMS.rating) && claim(j, 'basic:rating')) continue;
		if (hasWord(w, SYNONYMS.status) && claim(j, 'basic:status')) continue;
		if (hasWord(w, SYNONYMS.tags) && claim(j, 'basic:tags')) continue;
		if (hasWord(w, SYNONYMS.subtitle) && claim(j, 'basic:subtitle')) continue;
		if (hasWord(w, SYNONYMS.barcode) && claim(j, 'basic:barcode')) continue;
		if (looksLikeLinks && hasWord(w, SYNONYMS.image) && claim(j, 'basic:image')) continue;
		if (hasWord(w, SYNONYMS.notes) && claim(j, 'basic:notes')) continue;

		if (hasWord(w, SYNONYMS.price)) {
			const f = ctx.itemFields.find((x) => sameKey(x, 'price', 'cost', 'paid'));
			if (f && claim(j, `field:${f.key}`)) continue;
		}
		// "Whiskey Type" -> the Type field, when every word of the field's label is in the header
		const inside = ctx.itemFields.find((f) => {
			const lw = [...words(f.label)];
			return lw.length > 0 && lw.every((x) => w.has(x));
		});
		if (inside && claim(j, `field:${inside.key}`)) continue;

		if (filled(values).length) targets[j] = `new:${guessFieldType(values)}`;
		else targets[j] = 'skip';
	}

	// Every list needs names: take the first plain-text column if nothing was called "name"
	if (!taken.has('basic:name')) {
		const j = targets.findIndex((t) => t === 'new:text');
		const pick = j !== -1 ? j : targets.findIndex((t) => t === null || t?.startsWith('new:'));
		if (pick !== -1) {
			targets[pick] = 'basic:name';
			taken.add('basic:name');
		}
	}

	const final = targets.map((t) => t ?? 'skip');
	const statusCol = final.indexOf('basic:status');
	const ratingCol = final.indexOf('basic:rating');
	const ratingCells = ratingCol === -1 ? [] : column(table, ratingCol);
	return {
		targets: final,
		statusMap: statusCol === -1 ? {} : guessStatusMap(column(table, statusCol), ctx.statuses),
		ratingMax: null,
		ratingNotes: ratingCells.some((v) => (parseRatingCell(v)?.rest ?? '') !== '')
	};
}

// --- New fields -------------------------------------------------------------------------

export interface NewField {
	col: number;
	key: string;
	label: string;
	type: FieldType;
}

/** The fields to create for "new field" columns, with keys that don't clash with the list's own. */
export function planNewFields(table: Table, mapping: ImportMapping, ctx: ListContext): NewField[] {
	const used = new Set(ctx.itemFields.map((f) => f.key));
	const out: NewField[] = [];
	mapping.targets.forEach((t, col) => {
		const { kind, arg } = parseTarget(t);
		if (kind !== 'new') return;
		const label = (table.headers[col] ?? `Column ${col + 1}`).slice(0, 60);
		let key = fieldKey(label);
		for (let i = 2; used.has(key); i++) key = `${fieldKey(label)}_${i}`;
		used.add(key);
		out.push({ col, key, label, type: arg as FieldType });
	});
	return out;
}

/** Turns "new field" targets into ordinary field targets, and adds the fields to the context. */
export function withNewFields(
	mapping: ImportMapping,
	ctx: ListContext,
	fields: NewField[]
): { mapping: ImportMapping; ctx: ListContext } {
	const targets = [...mapping.targets];
	for (const f of fields) targets[f.col] = `field:${f.key}`;
	const defs: FieldDef[] = fields.map((f) => ({
		key: f.key,
		label: f.label,
		type: f.type,
		scope: 'item',
		options: [],
		unit: null,
		showOnCard: false
	}));
	return { mapping: { ...mapping, targets }, ctx: { ...ctx, itemFields: [...ctx.itemFields, ...defs] } };
}

// --- Checking a mapping -----------------------------------------------------------------

/** The first thing wrong with a mapping, in plain words, or null. */
export function validateMapping(mapping: ImportMapping, table: Table, ctx: ListContext): string | null {
	if (mapping.targets.length !== table.headers.length) return 'The columns changed. Start again.';
	const itemKeys = new Set(ctx.itemFields.map((f) => f.key));
	const logKeys = new Set(ctx.logFields.map((f) => f.key));
	const seen = new Set<string>();
	let date = false;
	let logUsed = false;
	for (const t of mapping.targets) {
		const { kind, arg } = parseTarget(t);
		const ok =
			t === 'skip' ||
			(kind === 'basic' && (BASIC_TARGETS as readonly string[]).includes(arg)) ||
			(kind === 'field' && itemKeys.has(arg)) ||
			(kind === 'logfield' && logKeys.has(arg)) ||
			(kind === 'log' && (LOG_TARGETS as readonly string[]).includes(arg)) ||
			(kind === 'new' && NEW_FIELD_TYPES.includes(arg as FieldType));
		if (!ok) return 'One of the columns has a destination that no longer exists.';
		if (kind !== 'new' && t !== 'skip') {
			if (seen.has(t)) return 'Two columns go to the same place. Each destination can be used once.';
			seen.add(t);
		}
		if (t === 'log:date') date = true;
		if (kind === 'logfield' || t === 'log:where' || t === 'log:notes') logUsed = true;
	}
	if (!seen.has('basic:name')) return 'Pick which column holds the names.';
	if (logUsed && !date) return 'Details about when it happened need a Date column too.';
	const keys = new Set(ctx.statuses.map((s) => s.key));
	for (const v of Object.values(mapping.statusMap)) {
		if (v !== '' && !keys.has(v)) return 'A status no longer exists. Start again.';
	}
	if (mapping.ratingMax !== null && !(mapping.ratingMax > 0 && mapping.ratingMax <= 1000)) {
		return 'Pick a rating scale.';
	}
	return null;
}

// --- Building rows ----------------------------------------------------------------------

export type RowResult = 'new' | 'update' | 'duplicate' | 'blank';

export interface BuiltRow {
	/** 0-based position among the data rows */
	index: number;
	result: RowResult;
	existingId: number | null;
	name: string;
	subtitle?: string;
	notes?: string;
	barcode?: string;
	tags: string[];
	image?: string;
	/** undefined: no status column. Otherwise the status key, or null for none */
	status?: string | null;
	/** The status cell was blank, so an item that already exists keeps the status it has */
	statusFromBlank: boolean;
	/** Stored 0–100 */
	rating?: number | null;
	custom: Record<string, unknown>;
	log?: { date: string; where?: string; notes?: string; custom: Record<string, unknown> };
	/** Choices that aren't in a pick-one field yet, per field key */
	newChoices: Record<string, string[]>;
	/** What each cell becomes, shown in the preview ('' when the column is skipped) */
	shown: string[];
	issues: { col: number; message: string }[];
}

interface Converted {
	value?: unknown;
	shown: string;
	issue?: string;
	choices?: string[];
}

function matchChoice(def: FieldDef, v: string) {
	const found = def.options.find((o) => o.toLowerCase() === v.toLowerCase());
	return { value: found ?? v, isNew: !found };
}

function convertField(def: FieldDef, raw: string): Converted {
	const v = raw.trim();
	if (!v) return { shown: '' };
	const bad = (what: string): Converted => ({
		shown: v,
		issue: `“${v.slice(0, 30)}” isn't ${what}, so it was left out`
	});
	switch (def.type) {
		case 'number': {
			const n = parseNumberCell(v);
			return n === null ? bad('a number') : { value: n, shown: String(n) };
		}
		case 'date': {
			const d = parseDateCell(v);
			return d === null ? bad('a date') : { value: d, shown: d };
		}
		case 'boolean': {
			const b = parseBooleanCell(v);
			if (b === undefined) return bad('yes or no');
			return b ? { value: true, shown: 'Yes' } : { shown: 'No' };
		}
		case 'url':
			return isUrl(v) ? { value: v, shown: v } : bad('a link');
		case 'select': {
			const { value, isNew } = matchChoice(def, v.slice(0, 200));
			return { value, shown: value, choices: isNew ? [value] : undefined };
		}
		case 'multiselect': {
			const parts = [
				...new Set(
					v
						.split(',')
						.map((x) => x.trim())
						.filter(Boolean)
				)
			].slice(0, 50);
			const matched = parts.map((p) => matchChoice(def, p.slice(0, 200)));
			return {
				value: matched.map((m) => m.value),
				shown: matched.map((m) => m.value).join(', '),
				choices: matched.filter((m) => m.isNew).map((m) => m.value)
			};
		}
		case 'longtext':
			return { value: v.slice(0, 10000), shown: v };
		default:
			return {
				value: v.slice(0, 500),
				shown: v,
				issue: v.length > 500 ? 'Shortened to 500 characters' : undefined
			};
	}
}

function splitTags(v: string) {
	return [
		...new Set(
			v
				.split(',')
				.map((t) => t.trim().replace(/\s+/g, ' ').slice(0, 40))
				.filter(Boolean)
		)
	].slice(0, 30);
}

/**
 * Turns every row into what will be saved. `ctx` and `mapping` must already have "new field"
 * columns resolved (see withNewFields).
 */
export function buildRows(table: Table, mapping: ImportMapping, ctx: ListContext): BuiltRow[] {
	const cols = mapping.targets.map(parseTarget);
	const itemDefs = new Map(ctx.itemFields.map((f) => [f.key, f]));
	const logDefs = new Map(ctx.logFields.map((f) => [f.key, f]));
	const statusLabel = new Map(ctx.statuses.map((s) => [s.key, s.label]));
	const hasStatus = cols.some((c) => c.kind === 'basic' && c.arg === 'status');
	const ratingCol = cols.findIndex((c) => c.kind === 'basic' && c.arg === 'rating');
	const defaultMax = mapping.ratingMax ?? (ratingCol === -1 ? 5 : guessRatingMax(column(table, ratingCol)));
	const seenNames = new Set<string>();

	return table.rows.map((row, index) => {
		const out: BuiltRow = {
			index,
			result: 'new',
			existingId: null,
			name: '',
			tags: [],
			statusFromBlank: false,
			custom: {},
			newChoices: {},
			shown: row.map(() => ''),
			issues: []
		};
		const notes: string[] = [];
		const logCustom: Record<string, unknown> = {};
		let logDate: string | null = null;
		let logWhere = '';
		const logNotes: string[] = [];
		let statusCell: string | null = null;

		cols.forEach((c, j) => {
			const cell = (row[j] ?? '').trim();
			const note = (message: string) => out.issues.push({ col: j, message });
			if (c.kind === 'basic') {
				switch (c.arg) {
					case 'name':
						out.name = cell.replace(/\s+/g, ' ').slice(0, 300);
						out.shown[j] = out.name;
						break;
					case 'subtitle':
						if (cell) out.subtitle = cell.slice(0, 300);
						out.shown[j] = cell;
						break;
					case 'notes':
						if (cell) notes.push(cell);
						out.shown[j] = cell;
						break;
					case 'barcode':
						if (cell) out.barcode = cell.replace(/\s/g, '').slice(0, 40);
						out.shown[j] = out.barcode ?? '';
						break;
					case 'tags':
						out.tags = splitTags(cell);
						out.shown[j] = out.tags.join(', ');
						break;
					case 'image':
						if (!cell) break;
						if (isUrl(cell)) out.image = cell;
						else note('Not a link, so no photo was added');
						out.shown[j] = cell;
						break;
					case 'status':
						statusCell = cell;
						break;
					case 'rating': {
						if (!cell) break;
						const r = parseRatingCell(cell);
						if (!r) {
							note(`“${cell.slice(0, 30)}” isn't a rating, so it was left out`);
							out.shown[j] = cell;
							break;
						}
						const max = r.max ?? defaultMax;
						if (r.value > max) {
							note(`${r.value} is above ${max}, so the rating was left out`);
							out.shown[j] = cell;
							break;
						}
						out.rating = toStored((r.value / max) * RATING_MAX);
						out.shown[j] = formatRating(out.rating);
						if (mapping.ratingNotes && r.rest) notes.push(r.rest);
						break;
					}
				}
			} else if (c.kind === 'field') {
				const def = itemDefs.get(c.arg);
				if (!def) return;
				const r = convertField(def, cell);
				if (r.issue) note(r.issue);
				if (r.value !== undefined) out.custom[def.key] = r.value;
				if (r.choices?.length) out.newChoices[def.key] = [...(out.newChoices[def.key] ?? []), ...r.choices];
				out.shown[j] = r.shown;
			} else if (c.kind === 'logfield') {
				const def = logDefs.get(c.arg);
				if (!def) return;
				const r = convertField(def, cell);
				if (r.issue) note(r.issue);
				if (r.value !== undefined) logCustom[def.key] = r.value;
				out.shown[j] = r.shown;
			} else if (c.kind === 'log') {
				if (c.arg === 'date') {
					if (cell) {
						logDate = parseDateCell(cell);
						if (logDate) out.shown[j] = logDate;
						else {
							note(`“${cell.slice(0, 30)}” isn't a date, so no log was added`);
							out.shown[j] = cell;
						}
					}
				} else if (c.arg === 'where') {
					logWhere = cell.slice(0, 300);
					out.shown[j] = logWhere;
				} else if (cell) {
					logNotes.push(cell);
					out.shown[j] = cell;
				}
			}
		});

		if (hasStatus) {
			const key = statusCellKey(statusCell ?? '');
			const chosen = key in mapping.statusMap ? mapping.statusMap[key] : guessStatus(key, ctx.statuses);
			out.status = chosen || null;
			out.statusFromBlank = key === '';
			const col = cols.findIndex((c) => c.kind === 'basic' && c.arg === 'status');
			out.shown[col] = out.status ? (statusLabel.get(out.status) ?? out.status) : '';
		}
		if (notes.length) out.notes = notes.join('\n\n').slice(0, 20000);
		if (logDate) {
			out.log = {
				date: logDate,
				where: logWhere || undefined,
				notes: logNotes.length ? logNotes.join('\n\n').slice(0, 20000) : undefined,
				custom: logCustom
			};
		}

		const norm = normTitle(out.name);
		if (!norm) out.result = 'blank';
		else if (seenNames.has(norm)) out.result = 'duplicate';
		else out.result = ctx.existing[norm] ? 'update' : 'new';
		if (norm) {
			seenNames.add(norm);
			out.existingId = ctx.existing[norm] ?? null;
		}
		return out;
	});
}

/** Rows to leave out unless the user ticks them: blanks and repeats of an earlier name. */
export function defaultSkipped(rows: BuiltRow[]) {
	return rows.filter((r) => r.result === 'blank' || r.result === 'duplicate').map((r) => r.index);
}

export interface Counts {
	rows: number;
	created: number;
	updated: number;
	skipped: number;
	logs: number;
}

export function countRows(rows: BuiltRow[], skipped: Set<number>): Counts {
	const c: Counts = { rows: rows.length, created: 0, updated: 0, skipped: 0, logs: 0 };
	for (const r of rows) {
		if (r.result === 'blank' || skipped.has(r.index)) c.skipped++;
		else {
			// A repeated name updates the item its first row made
			if (r.result === 'update' || r.result === 'duplicate' || r.existingId) c.updated++;
			else c.created++;
			if (r.log) c.logs++;
		}
	}
	return c;
}
