import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '@sveltejs/kit';
import { cfg } from '$lib/server/config';
import {
	applyYamtrackImport,
	ImportError,
	planYamtrackImport,
	previewYamtrackImport
} from '$lib/server/import/yamtrack';
import type { Actions } from './$types';

const MAX_CSV = 50 * 1024 * 1024;

function tmpFile(userId: number, token: string) {
	if (!/^[0-9a-f-]{36}$/.test(token)) return null;
	return path.join(cfg().tmpDir, `yamtrack-u${userId}-${token}.csv`);
}

export const actions: Actions = {
	preview: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0)
			return fail(400, { message: 'Choose your Yamtrack CSV export.' });
		if (file.size > MAX_CSV) return fail(400, { message: 'That file is larger than 50 MB.' });
		const text = await file.text();
		try {
			const plan = planYamtrackImport(text);
			const token = crypto.randomUUID();
			await fs.mkdir(cfg().tmpDir, { recursive: true });
			await fs.writeFile(tmpFile(userId, token)!, text, 'utf8');
			return {
				token,
				fileName: file.name,
				rows: plan.rows,
				skipped: plan.skipped,
				summary: previewYamtrackImport(userId, plan)
			};
		} catch (e) {
			if (e instanceof ImportError) return fail(400, { message: e.message });
			throw e;
		}
	},

	commit: async ({ request, locals }) => {
		const userId = locals.user!.id;
		const token = String((await request.formData()).get('token') ?? '');
		const file = tmpFile(userId, token);
		if (!file) return fail(400, { message: 'The upload expired. Choose the file again.' });
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch {
			return fail(400, { message: 'The upload expired. Choose the file again.' });
		}
		const result = applyYamtrackImport(userId, planYamtrackImport(text));
		await fs.rm(file, { force: true });
		return { done: result };
	}
};
