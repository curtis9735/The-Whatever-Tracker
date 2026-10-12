import { userAgent } from '../settings';
import { cached, fetchOk, ProviderError, withTimeout } from './util';

const DAY = 86_400_000;

export interface BarcodeProduct {
	barcode: string;
	title: string;
	brand?: string;
	quantity?: string;
	imageUrl?: string;
	categories?: string;
	url: string;
}

export function isBarcode(code: string) {
	return /^\d{6,14}$/.test(code);
}

export function normalizeOff(code: string, json: { status?: number; product?: Record<string, unknown> }) {
	if (json.status !== 1 || !json.product) return null;
	const p = json.product as Record<string, string | undefined>;
	const title = p.product_name_en || p.product_name || p.generic_name;
	if (!title) return null;
	return {
		barcode: code,
		title: title.trim(),
		brand: p.brands?.split(',')[0]?.trim() || undefined,
		quantity: p.quantity || undefined,
		imageUrl: p.image_front_url || p.image_url || undefined,
		categories: p.categories || undefined,
		url: `https://world.openfoodfacts.org/product/${code}`
	} satisfies BarcodeProduct;
}

/** Looks a barcode up in Open Food Facts (food and drink, incl. many bottles and sauces). */
export async function lookupOpenFoodFacts(
	code: string,
	signal?: AbortSignal
): Promise<BarcodeProduct | null> {
	if (!isBarcode(code)) throw new ProviderError('That does not look like a barcode', 400);
	return cached(`off:${code}`, 7 * DAY, async () => {
		const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,generic_name,brands,quantity,image_front_url,image_url,categories`;
		try {
			const res = await fetchOk(url, {
				headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
				signal: withTimeout(signal, 8000),
				label: 'Open Food Facts'
			});
			return normalizeOff(code, await res.json());
		} catch (e) {
			if (e instanceof ProviderError && e.status === 404) return null;
			throw e;
		}
	});
}
