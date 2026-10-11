import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { rawDb } from './db';
import { pruneProviderCache } from './providers/util';

function stamp(d = new Date()) {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Consistent snapshot of the live database (safe while the app is running). */
export function runBackup(now = new Date()) {
	const { backupsDir, backupKeep } = cfg();
	fs.mkdirSync(backupsDir, { recursive: true });
	const file = path.join(backupsDir, `tracker-${stamp(now)}.db`);
	if (!fs.existsSync(file)) {
		rawDb().prepare('VACUUM INTO ?').run(file);
		console.log(`[backup] wrote ${file}`);
	}
	const old = listBackups().slice(backupKeep);
	for (const b of old) fs.rmSync(path.join(backupsDir, b.name), { force: true });
}

export function listBackups() {
	const { backupsDir } = cfg();
	if (!fs.existsSync(backupsDir)) return [];
	return fs
		.readdirSync(backupsDir)
		.filter((n) => /^tracker-\d{8}\.db$/.test(n))
		.map((name) => {
			const st = fs.statSync(path.join(backupsDir, name));
			return { name, size: st.size, modified: st.mtime };
		})
		.sort((a, b) => b.name.localeCompare(a.name));
}

let timer: NodeJS.Timeout | null = null;

/** Checks hourly; takes one snapshot per day (after 3am local) and tidies the provider cache. */
export function startBackupScheduler() {
	if (timer) return;
	const tick = () => {
		try {
			const now = new Date();
			const today = `tracker-${stamp(now)}.db`;
			const hasToday = listBackups().some((b) => b.name === today);
			if (!hasToday && (now.getHours() >= 3 || listBackups().length === 0)) runBackup(now);
			pruneProviderCache();
		} catch (e) {
			console.error('[backup] failed', e);
		}
	};
	setTimeout(tick, 30_000).unref();
	timer = setInterval(tick, 60 * 60 * 1000);
	timer.unref();
}
