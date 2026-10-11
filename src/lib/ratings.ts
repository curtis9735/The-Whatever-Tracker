import type { RatingScale } from './types';

/** Display range for each scale. Ratings are stored as 0–100 integers. */
export const SCALES: Record<RatingScale, { max: number; step: number; label: string }> = {
	'5star': { max: 5, step: 0.5, label: '5 stars (halves)' },
	'10': { max: 10, step: 0.5, label: '10 points' },
	'100': { max: 100, step: 1, label: '100 points' }
};

export function toStored(display: number | null | undefined, scale: RatingScale): number | null {
	if (display === null || display === undefined || Number.isNaN(display)) return null;
	const { max, step } = SCALES[scale];
	const snapped = Math.round(Math.min(Math.max(display, 0), max) / step) * step;
	return Math.round((snapped / max) * 100);
}

export function toDisplay(stored: number | null | undefined, scale: RatingScale): number | null {
	if (stored === null || stored === undefined) return null;
	const { max, step } = SCALES[scale];
	const raw = (stored / 100) * max;
	// Snap to the scale's step so 5-star values stay on halves
	return Math.round(raw / step) * step;
}

export function formatRating(stored: number | null | undefined, scale: RatingScale): string {
	const v = toDisplay(stored, scale);
	if (v === null) return '';
	if (scale === '5star') return `${trim(v)}★`;
	if (scale === '10') return `${trim(v)}/10`;
	return `${trim(v)}/100`;
}

function trim(n: number) {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Parses a form value in the given scale; empty means "no rating". */
export function parseRatingInput(raw: unknown, scale: RatingScale): number | null {
	if (raw === null || raw === undefined) return null;
	const s = String(raw).trim();
	if (s === '') return null;
	const n = Number(s);
	if (!Number.isFinite(n)) return null;
	return toStored(n, scale);
}
