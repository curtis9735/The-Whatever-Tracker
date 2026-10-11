import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ precompress: true }),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// wasm-unsafe-eval lets the barcode scanner compile its (self-hosted) WebAssembly decoder
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': ['self', 'unsafe-inline'],
				// Linked images and provider artwork (TMDB, IGDB, BGG, Cover Art Archive) load from anywhere
				'img-src': ['self', 'data:', 'blob:', 'https:', 'http:'],
				'media-src': ['self', 'blob:'],
				'connect-src': ['self'],
				'font-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['self']
			}
		}
	}
};

export default config;
