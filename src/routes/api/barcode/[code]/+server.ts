import { error, json } from '@sveltejs/kit';
import { findByBarcode } from '$lib/server/search/local';
import { isBarcode, lookupOpenFoodFacts } from '$lib/server/providers/openfoodfacts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, request }) => {
	const code = params.code.replace(/\D/g, '');
	if (!isBarcode(code)) error(400, 'That does not look like a barcode');

	const library = findByBarcode(locals.user!.id, code);
	if (library.length) return json({ code, library, product: null });

	let product = null;
	try {
		product = await lookupOpenFoodFacts(code, request.signal);
	} catch (e) {
		// Lookup is best-effort: fall through to a blank form with the barcode filled in
		console.warn('[barcode] Open Food Facts lookup failed', (e as Error).message);
	}
	return json({ code, library: [], product });
};
