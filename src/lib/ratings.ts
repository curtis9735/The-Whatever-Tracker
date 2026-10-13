// Every rating is a whole number from 1 to 10. It is stored as 0–100 (tens only), which keeps
// sorting and "minimum rating" filters simple.

export const RATING_MAX = 10;

/** A whole number out of 10 (anything between is rounded, anything outside is clamped). */
export function toStored(display: number | null | undefined): number | null {
	if (display === null || display === undefined || Number.isNaN(display)) return null;
	return Math.round(Math.min(Math.max(display, 0), RATING_MAX)) * 10;
}

export function toDisplay(stored: number | null | undefined): number | null {
	if (stored === null || stored === undefined) return null;
	return Math.round(stored / 10);
}

export function formatRating(stored: number | null | undefined): string {
	const v = toDisplay(stored);
	return v === null ? '' : `${v}/${RATING_MAX}`;
}

/** Parses a form value out of 10; empty means "no rating". */
export function parseRatingInput(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	const s = String(raw).trim();
	if (s === '') return null;
	const n = Number(s);
	if (!Number.isFinite(n)) return null;
	return toStored(n);
}
