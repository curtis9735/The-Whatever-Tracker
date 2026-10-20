import { error, fail } from '@sveltejs/kit';
import { parseEpisodePick } from '$lib/server/forms';
import { ProviderError } from '$lib/server/providers/util';
import { tmdbProblem } from '$lib/server/services/episodes';
import {
	cancelWatching,
	dismissFinished,
	finishWatching,
	pauseWatching,
	resumeWatching,
	startWatching,
	undoFinished,
	WatchConflict,
	WatchError
} from '$lib/server/services/watching';
import type { Actions } from './$types';

// "Watching now": the page itself reads the app layout's `watching`; these are its buttons (and the
// item page's and the now-watching bar's, which post here)

function positiveId(form: FormData, name: string, what: string) {
	const id = Number(form.get(name));
	if (!Number.isInteger(id) || id <= 0) error(404, `${what} not found`);
	return id;
}

const checkinId = (form: FormData) => positiveId(form, 'id', 'Check-in');

function watchFailure(e: unknown) {
	if (e instanceof WatchConflict) {
		return fail(409, { conflict: { title: e.title, label: e.label, itemId: e.itemId } });
	}
	if (e instanceof WatchError) return fail(e.status, { watchError: e.message });
	if (e instanceof ProviderError || (e as Error)?.name === 'TimeoutError') {
		return fail(502, { watchError: tmdbProblem(e) });
	}
	throw e;
}

export const actions: Actions = {
	/** Checks in live: `itemId`, and `season` + `episode` for a show; `replace` (finish|cancel) for one already running */
	start: async ({ request, locals }) => {
		const form = await request.formData();
		const itemId = positiveId(form, 'itemId', 'Item');
		const pick = parseEpisodePick(form, '');
		if (pick === 'invalid') return fail(400, { watchError: 'Pick a season and episode.' });
		const r = String(form.get('replace') ?? '');
		const replace = r === 'finish' || r === 'cancel' ? r : undefined;
		try {
			return { started: await startWatching(locals.user!.id, itemId, pick, { replace }) };
		} catch (e) {
			return watchFailure(e);
		}
	},

	pause: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		try {
			await pauseWatching(locals.user!.id, id);
			return { paused: true };
		} catch (e) {
			return watchFailure(e);
		}
	},

	resume: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		try {
			resumeWatching(locals.user!.id, id);
			return { resumed: true };
		} catch (e) {
			return watchFailure(e);
		}
	},

	/** "Mark watched now" */
	finish: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		try {
			const finished = await finishWatching(locals.user!.id, id);
			if (!finished) return fail(409, { watchError: 'That check-in already ended.' });
			return { finished };
		} catch (e) {
			return watchFailure(e);
		}
	},

	cancel: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		try {
			cancelWatching(locals.user!.id, id);
			return { cancelled: true };
		} catch (e) {
			return watchFailure(e);
		}
	},

	/** Takes back a finished check-in's play or log, and its status */
	undo: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		try {
			await undoFinished(locals.user!.id, id);
			return { undone: true };
		} catch (e) {
			return watchFailure(e);
		}
	},

	dismiss: async ({ request, locals }) => {
		const id = checkinId(await request.formData());
		dismissFinished(locals.user!.id, id);
		return { dismissed: true };
	}
};
