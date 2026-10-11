import path from 'node:path';
import { env } from '$env/dynamic/private';

export const APP_VERSION = __APP_VERSION__;

/** Read at call time: Docker passes env at runtime, not at build time. */
export function cfg() {
	const dataDir = path.resolve(env.DATA_DIR || './data');
	return {
		dataDir,
		dbPath: path.join(dataDir, 'tracker.db'),
		uploadsDir: path.join(dataDir, 'uploads'),
		backupsDir: path.join(dataDir, 'backups'),
		tmpDir: path.join(dataDir, 'tmp'),
		migrationsDir: path.resolve(env.MIGRATIONS_DIR || './drizzle'),
		backupKeep: Math.max(1, Number(env.BACKUP_KEEP || 7)),
		tmdbKey: (env.TMDB_API_KEY || '').trim(),
		igdbClientId: (env.IGDB_CLIENT_ID || '').trim(),
		igdbClientSecret: (env.IGDB_CLIENT_SECRET || '').trim(),
		bggToken: (env.BGG_API_TOKEN || '').trim(),
		setlistfmKey: (env.SETLISTFM_API_KEY || '').trim(),
		musicbrainzContact: (env.MUSICBRAINZ_CONTACT || '').trim()
	};
}

export function userAgent() {
	const contact = cfg().musicbrainzContact || 'https://github.com/';
	return `WhateverTracker/${APP_VERSION} ( ${contact} )`;
}
