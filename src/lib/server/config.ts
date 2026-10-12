import path from 'node:path';
import { env } from '$env/dynamic/private';

export const APP_VERSION = __APP_VERSION__;

/**
 * Paths and limits, read at call time (Docker passes env at runtime, not at build time).
 * API credentials live in ./settings.ts because they can also be changed in the UI.
 */
export function cfg() {
	const dataDir = path.resolve(env.DATA_DIR || './data');
	return {
		dataDir,
		dbPath: path.join(dataDir, 'tracker.db'),
		uploadsDir: path.join(dataDir, 'uploads'),
		backupsDir: path.join(dataDir, 'backups'),
		tmpDir: path.join(dataDir, 'tmp'),
		migrationsDir: path.resolve(env.MIGRATIONS_DIR || './drizzle'),
		backupKeep: Math.max(1, Number(env.BACKUP_KEEP || 7))
	};
}
