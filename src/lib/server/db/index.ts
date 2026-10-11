import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cfg } from '../config';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let sqlite: Database.Database | null = null;
let instance: DB | null = null;

/** Opens the database (once) and runs pending migrations. */
export function db(): DB {
	if (instance) return instance;
	const c = cfg();
	fs.mkdirSync(c.dataDir, { recursive: true });
	instance = openDatabase(c.dbPath, c.migrationsDir);
	return instance;
}

export function openDatabase(file: string, migrationsDir: string): DB {
	sqlite = new Database(file);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('synchronous = NORMAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	const d = drizzle(sqlite, { schema });
	migrate(d, { migrationsFolder: migrationsDir });
	return d;
}

/** Raw better-sqlite3 handle for FTS queries and VACUUM INTO. */
export function rawDb(): Database.Database {
	db();
	return sqlite!;
}

export { schema };
