import { error } from '@sveltejs/kit';
import { rawDb } from '../db';
import type { ListAccess, ShareRole } from '$lib/types';

/*
 * Sharing a list with others in the household. The list, its items, fields, tags and photos belong to
 * the list's owner (items.user_id is always the list owner's). Everyone the list is shared with keeps
 * their own progress: status, rating, favorite and notes (the owner's on the item itself, everyone
 * else's in item_progress), plus their own logs and TV episodes.
 */

const RANK: Record<ListAccess, number> = { view: 0, edit: 1, owner: 2 };

/** The viewer's access to a list, or null when it isn't theirs and isn't shared with them */
export function listAccess(userId: number, categoryId: number): ListAccess | null {
	const row = rawDb()
		.prepare(
			`SELECT c.user_id AS owner, s.role FROM categories c
			 LEFT JOIN list_shares s ON s.category_id = c.id AND s.user_id = ?
			 WHERE c.id = ?`
		)
		.get(userId, categoryId) as { owner: number; role: ShareRole | null } | undefined;
	if (!row) return null;
	if (row.owner === userId) return 'owner';
	return row.role ?? null;
}

export function allows(access: ListAccess | null | undefined, need: ListAccess) {
	return !!access && RANK[access] >= RANK[need];
}

/** 404 when the list isn't the viewer's to see, 403 when they may see it but not do this */
export function requireAccess(access: ListAccess | null | undefined, need: ListAccess, notFound: string) {
	if (!access) error(404, notFound);
	if (!allows(access, need)) {
		error(
			403,
			need === 'owner'
				? "Only the list's owner can do that."
				: 'This list is shared with you to view: you can keep your own progress, but not change its items.'
		);
	}
}

// --- SQL building blocks -------------------------------------------------------------------------
// A query starts `FROM ${ME} CROSS JOIN …` and binds the viewer's id first; `me.id` can then be used
// anywhere in it (subqueries included) without binding it again.

/** The person looking */
export const ME = '(SELECT ? AS id) me';

/** Joins `sh`, the viewer's share of list `c` (none when it's their own list) */
export const SHARE_JOIN = 'LEFT JOIN list_shares sh ON sh.category_id = c.id AND sh.user_id = me.id';

/** List `c` is the viewer's or shared with them (needs SHARE_JOIN) */
export const SEES_LIST = '(c.user_id = me.id OR sh.user_id IS NOT NULL)';

/** List `c` is the viewer's or shared with them, without a join */
export const seesList = (c = 'c') =>
	`(${c}.user_id = me.id OR EXISTS (SELECT 1 FROM list_shares s2 WHERE s2.category_id = ${c}.id AND s2.user_id = me.id))`;

/** Joins `p`, the viewer's own progress on item `i` when the item isn't theirs */
export const PROGRESS_JOIN = 'LEFT JOIN item_progress p ON p.item_id = i.id AND p.user_id = me.id';

type PersonalColumn = 'status' | 'rating' | 'favorite' | 'notes' | 'last_logged_at';

/** One of item `i`'s personal columns as the viewer sees it: theirs, never another person's (needs PROGRESS_JOIN) */
export function mine(col: PersonalColumn) {
	return col === 'favorite'
		? 'IIF(i.user_id = me.id, i.favorite, COALESCE(p.favorite, 0))'
		: `IIF(i.user_id = me.id, i.${col}, p.${col})`;
}

/**
 * When item `i` last changed for the viewer. The owner's progress is on the item, so items.updated_at
 * moves with it; for anyone else it's when they last changed their own progress, or when it was added.
 */
export const MINE_UPDATED = 'IIF(i.user_id = me.id, i.updated_at, COALESCE(p.updated_at, i.created_at))';

/** List `c`'s "Up next" and "Calendar" choices: the owner's on the list, everyone else's on their share */
export const MINE_UP_NEXT = 'IIF(c.user_id = me.id, c.show_up_next, sh.show_up_next)';
export const MINE_IN_CALENDAR = 'IIF(c.user_id = me.id, c.show_in_calendar, sh.show_in_calendar)';

// --- Sharing ---------------------------------------------------------------------------------------

export interface Person {
	id: number;
	username: string;
	displayName: string;
}

/** Everyone else with an account here, who a list can be shared with */
export function householdMembers(userId: number): Person[] {
	return rawDb()
		.prepare(
			`SELECT id, username, display_name AS displayName FROM users WHERE id != ?
			 ORDER BY display_name COLLATE NOCASE, username`
		)
		.all(userId) as Person[];
}

export interface ShareRow extends Person {
	role: ShareRole;
}

/** Who a list is shared with */
export function listSharesOf(categoryId: number): ShareRow[] {
	return rawDb()
		.prepare(
			`SELECT u.id, u.username, u.display_name AS displayName, s.role FROM list_shares s
			 JOIN users u ON u.id = s.user_id WHERE s.category_id = ?
			 ORDER BY u.display_name COLLATE NOCASE, u.username`
		)
		.all(categoryId) as ShareRow[];
}

/**
 * Sets who a list is shared with (the owner's list only; `role: null` stops sharing with them).
 * Someone it stops being shared with keeps their progress and logs; they come back if it's shared again.
 */
export function saveShares(
	ownerId: number,
	categoryId: number,
	entries: { userId: number; role: ShareRole | null }[]
) {
	requireAccess(listAccess(ownerId, categoryId), 'owner', 'Category not found');
	const sqlite = rawDb();
	const known = new Set(householdMembers(ownerId).map((p) => p.id));
	const upsert = sqlite.prepare(
		`INSERT INTO list_shares (category_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (category_id, user_id) DO UPDATE SET role = excluded.role`
	);
	const remove = sqlite.prepare('DELETE FROM list_shares WHERE category_id = ? AND user_id = ?');
	sqlite.transaction(() => {
		for (const e of entries) {
			if (!known.has(e.userId)) continue;
			if (e.role === 'edit' || e.role === 'view') upsert.run(categoryId, e.userId, e.role, Date.now());
			else remove.run(categoryId, e.userId);
		}
	})();
}

/** Someone a list is shared with stops seeing it (their progress stays, as when the owner stops sharing) */
export function leaveList(userId: number, categoryId: number) {
	rawDb().prepare('DELETE FROM list_shares WHERE category_id = ? AND user_id = ?').run(categoryId, userId);
}

/** The viewer's own "Up next" / "Calendar" choice for a list: on the list for its owner, on their share otherwise */
export function setMyListSettings(
	userId: number,
	categoryId: number,
	settings: { showUpNext?: boolean; showInCalendar?: boolean }
) {
	const access = listAccess(userId, categoryId);
	requireAccess(access, 'view', 'Category not found');
	const sets: string[] = [];
	const values: number[] = [];
	if (settings.showUpNext !== undefined) {
		sets.push('show_up_next = ?');
		values.push(settings.showUpNext ? 1 : 0);
	}
	if (settings.showInCalendar !== undefined) {
		sets.push('show_in_calendar = ?');
		values.push(settings.showInCalendar ? 1 : 0);
	}
	if (!sets.length) return;
	if (access === 'owner') {
		rawDb()
			.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`)
			.run(...values, categoryId);
	} else {
		rawDb()
			.prepare(`UPDATE list_shares SET ${sets.join(', ')} WHERE category_id = ? AND user_id = ?`)
			.run(...values, categoryId, userId);
	}
}

/** A photo file under someone else's folder: shown to people who can see the item (or log's item) it's on */
export function canSeeUpload(userId: number, rel: string) {
	if (rel.startsWith(`u${userId}/`)) return true;
	const row = rawDb()
		.prepare(
			`SELECT i.category_id AS categoryId FROM images im
			 LEFT JOIN item_logs l ON l.id = im.log_id
			 JOIN items i ON i.id = COALESCE(im.item_id, l.item_id)
			 WHERE im.path = ? OR im.thumb_path = ? LIMIT 1`
		)
		.get(rel, rel) as { categoryId: number } | undefined;
	return !!row && listAccess(userId, row.categoryId) !== null;
}
