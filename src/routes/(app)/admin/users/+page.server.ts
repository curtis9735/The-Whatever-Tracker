import fs from 'node:fs/promises';
import path from 'node:path';
import { error, fail } from '@sveltejs/kit';
import { asc, count, eq } from 'drizzle-orm';
import { db, rawDb, schema } from '$lib/server/db';
import {
	hashPassword,
	invalidateUserSessions,
	normalizeUsername,
	validatePassword,
	validateUsername
} from '$lib/server/auth';
import { cfg } from '$lib/server/config';
import { deleteStoredFiles } from '$lib/server/images/store';
import type { Actions, PageServerLoad } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user?.isAdmin) error(403, 'Only admins can manage accounts');
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const users = db()
		.select({
			id: schema.users.id,
			username: schema.users.username,
			displayName: schema.users.displayName,
			isAdmin: schema.users.isAdmin,
			createdAt: schema.users.createdAt
		})
		.from(schema.users)
		.orderBy(asc(schema.users.createdAt))
		.all();
	const counts = new Map(
		db()
			.select({ userId: schema.items.userId, n: count() })
			.from(schema.items)
			.groupBy(schema.items.userId)
			.all()
			.map((r) => [r.userId, r.n])
	);
	// Lists each person shares with others, which go for everyone if their account is deleted
	const shared = new Map(
		(
			rawDb()
				.prepare(
					`SELECT c.user_id AS userId, COUNT(DISTINCT c.id) AS n FROM categories c
					 JOIN list_shares s ON s.category_id = c.id GROUP BY c.user_id`
				)
				.all() as { userId: number; n: number }[]
		).map((r) => [r.userId, r.n])
	);
	return {
		users: users.map((u) => ({
			...u,
			createdAt: u.createdAt.toISOString(),
			items: counts.get(u.id) ?? 0,
			sharedLists: shared.get(u.id) ?? 0
		}))
	};
};

function adminCount() {
	return db().select({ n: count() }).from(schema.users).where(eq(schema.users.isAdmin, true)).get()?.n ?? 0;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const username = normalizeUsername(String(form.get('username') ?? ''));
		const displayName =
			String(form.get('displayName') ?? '')
				.trim()
				.slice(0, 60) || username;
		const password = String(form.get('password') ?? '');
		const err = validateUsername(username) ?? validatePassword(password);
		if (err) return fail(400, { message: err, username, displayName });
		const exists = db()
			.select({ id: schema.users.id })
			.from(schema.users)
			.where(eq(schema.users.username, username))
			.get();
		if (exists) return fail(400, { message: 'That username is taken.', username, displayName });
		db()
			.insert(schema.users)
			.values({
				username,
				displayName,
				passwordHash: await hashPassword(password),
				isAdmin: form.get('isAdmin') === 'on'
			})
			.run();
		return { created: username };
	},

	reset: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const password = String(form.get('password') ?? '');
		const err = validatePassword(password);
		if (err) return fail(400, { message: err });
		db()
			.update(schema.users)
			.set({ passwordHash: await hashPassword(password) })
			.where(eq(schema.users.id, id))
			.run();
		if (id !== locals.user!.id) invalidateUserSessions(id);
		return { reset: id };
	},

	toggleAdmin: async ({ request, locals }) => {
		requireAdmin(locals);
		const id = Number((await request.formData()).get('id'));
		const user = db().select().from(schema.users).where(eq(schema.users.id, id)).get();
		if (!user) return fail(404, { message: 'No such user' });
		if (user.isAdmin && adminCount() <= 1) return fail(400, { message: 'There must be at least one admin.' });
		db().update(schema.users).set({ isAdmin: !user.isAdmin }).where(eq(schema.users.id, id)).run();
	},

	delete: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (id === locals.user!.id) return fail(400, { message: 'You cannot delete your own account.' });
		const user = db().select().from(schema.users).where(eq(schema.users.id, id)).get();
		if (!user) return fail(404, { message: 'No such user' });
		if (String(form.get('confirm') ?? '').trim() !== user.username) {
			return fail(400, { message: `Type ${user.username} to confirm deleting that account.` });
		}
		// Their lists go with them, and so do other people's logs on those lists: those logs' photos
		// are in their writers' folders, so they're removed one by one
		const othersPhotos = rawDb()
			.prepare(
				`SELECT im.path, im.thumb_path AS thumbPath FROM images im
				 JOIN item_logs l ON l.id = im.log_id JOIN items i ON i.id = l.item_id
				 WHERE i.user_id = ? AND im.user_id != ?`
			)
			.all(id, id) as { path: string | null; thumbPath: string | null }[];
		db().delete(schema.users).where(eq(schema.users.id, id)).run();
		await fs.rm(path.join(cfg().uploadsDir, `u${id}`), { recursive: true, force: true });
		for (const img of othersPhotos) await deleteStoredFiles(img);
		return { deleted: user.username };
	}
};
