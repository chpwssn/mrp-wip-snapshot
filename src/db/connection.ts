import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  logger.info(`Opening database at ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  ensureSchema(db);

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
