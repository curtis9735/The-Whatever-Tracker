import { fail } from '@sveltejs/kit';
import { keys } from '$lib/server/settings';
import {
	connectLastfm,
	deleteImportedListening,
	disconnectLastfm,
	getLastfmAccount,
	hasImportedListening,
	lastfmTargetLists,
	LastfmUserError,
	previewDeleteImported,
	readdRemovedAlbums,
	requestSync,
	updateLastfmSettings
} from '$lib/server/services/lastfm-sync';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	const account = getLastfmAccount(userId);
	const lists = lastfmTargetLists(userId);
	const imported = hasImportedListening(userId);
	return {
		lastfmReady: !!keys().lastfmKey,
		isAdmin: locals.user!.isAdmin,
		account,
		// Listening is stored (also after "Stop syncing"), so it can be deleted
		imported,
		lists,
		// What "Delete imported listening" would remove, for its confirmation
		deletePreview: account || imported ? previewDeleteImported(userId) : null
	};
};

const message = (e: unknown) => (e instanceof LastfmUserError ? e.message : null);

export const actions: Actions = {
	connect: async ({ request, locals }) => {
		const form = await request.formData();
		const username = String(form.get('username') ?? '');
		const pick = String(form.get('category') ?? '');
		const categoryId = pick === 'new' ? 'new' : Number(pick);
		if (categoryId !== 'new' && !Number.isInteger(categoryId)) {
			return fail(400, { connectError: 'Pick the list to put albums in.', username });
		}
		try {
			await connectLastfm(locals.user!.id, { username, categoryId });
		} catch (e) {
			const m = message(e);
			if (m) return fail(400, { connectError: m, username });
			throw e;
		}
		return {
			connected: 'Connected. Importing your history: this runs in the background, you can leave this page.'
		};
	},

	save: async ({ request, locals }) => {
		const form = await request.formData();
		const category = Number(form.get('category'));
		const syncEvery = String(form.get('syncEvery') ?? '');
		const journalMode = String(form.get('journalMode') ?? '');
		try {
			updateLastfmSettings(locals.user!.id, {
				categoryId: Number.isInteger(category) && category > 0 ? category : undefined,
				syncEvery: syncEvery === 'daily' ? 'daily' : 'hourly',
				journalMode: journalMode === 'hide' || journalMode === 'all' ? journalMode : 'group'
			});
		} catch (e) {
			const m = message(e);
			if (m) return fail(400, { saveError: m });
			throw e;
		}
		return { saved: true };
	},

	sync: async ({ locals }) => {
		const r = requestSync(locals.user!.id);
		return r.started ? { syncStarted: true } : fail(400, { syncError: r.reason ?? "Couldn't start a sync." });
	},

	disconnect: async ({ locals }) => {
		disconnectLastfm(locals.user!.id);
		return { disconnected: 'Stopped syncing. Everything imported so far stays.' };
	},

	deleteImported: async ({ locals }) => {
		const r = deleteImportedListening(locals.user!.id);
		return { deleted: r };
	},

	readd: async ({ locals }) => {
		return { readded: readdRemovedAlbums(locals.user!.id) };
	}
};
