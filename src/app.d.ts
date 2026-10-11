// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	const __APP_VERSION__: string;

	namespace App {
		interface Locals {
			user: {
				id: number;
				username: string;
				displayName: string;
				isAdmin: boolean;
				onboarded: boolean;
			} | null;
			sessionId: string | null;
		}
	}
}

export {};
