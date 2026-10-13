import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rating-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const { rawDb } = await import('./db');

describe('the "everything is out of 10" upgrade', () => {
	it('lists no longer have a rating scale', () => {
		const columns = (rawDb().prepare('PRAGMA table_info(categories)').all() as { name: string }[]).map(
			(c) => c.name
		);
		expect(columns).not.toContain('rating_scale');
	});

	it('rounds existing ratings to whole numbers out of 10, whatever scale they came from', () => {
		const sqlite = rawDb();
		const user = Number(
			sqlite
				.prepare(
					"INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('old', 'old', 'x', 0)"
				)
				.run().lastInsertRowid
		);
		const cat = Number(
			sqlite
				.prepare(
					`INSERT INTO categories (user_id, name, slug, statuses, provider_kinds, created_at)
					 VALUES (?, 'Old', 'old', '[]', '[]', 0)`
				)
				.run(user).lastInsertRowid
		);
		const add = (title: string, rating: number | null) =>
			Number(
				sqlite
					.prepare(
						`INSERT INTO items (user_id, category_id, title, rating, custom, created_at, updated_at)
						 VALUES (?, ?, ?, ?, '{}', 0, 0)`
					)
					.run(user, cat, title, rating).lastInsertRowid
			);
		// 4.5 stars, 85/100, 7.5/10, 91/100, 3.5 stars, nothing
		const ids = [90, 85, 75, 91, 70, null].map((r, i) => add(`item ${i}`, r));
		const log = Number(
			sqlite
				.prepare(
					"INSERT INTO item_logs (item_id, user_id, date, rating, custom, created_at) VALUES (?, ?, '2026-01-01', 88, '{}', 0)"
				)
				.run(ids[0], user).lastInsertRowid
		);

		// Run the data part of the upgrade (the column is already gone in this database)
		const sql = fs.readFileSync(path.resolve('drizzle/0004_rating_out_of_ten.sql'), 'utf8');
		for (const stmt of sql.split('--> statement-breakpoint')) {
			const run = stmt
				.split('\n')
				.filter((l) => !l.trim().startsWith('--'))
				.join('\n')
				.trim();
			if (run.toUpperCase().startsWith('UPDATE')) sqlite.exec(run);
		}

		const rating = (id: number) =>
			(sqlite.prepare('SELECT rating FROM items WHERE id = ?').get(id) as { rating: number | null }).rating;
		expect(ids.map(rating)).toEqual([90, 90, 80, 90, 70, null]);
		expect(
			(sqlite.prepare('SELECT rating FROM item_logs WHERE id = ?').get(log) as { rating: number }).rating
		).toBe(90);
	});
});
