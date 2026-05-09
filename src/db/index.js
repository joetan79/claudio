import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

let systemDb = null;
const userDbs = new Map();

export function getSystemDb() {
  if (systemDb) return systemDb;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  systemDb = new Database(path.join(DATA_DIR, 'system.db'));
  systemDb.pragma('journal_mode = WAL');

  systemDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username     TEXT UNIQUE NOT NULL,
      created_at   INTEGER NOT NULL,
      last_login   INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    );
  `);

  // Add role column to existing DBs (no-op on new ones)
  try { systemDb.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`); } catch {}

  // Auto-create admin account on first start
  const adminExists = systemDb.prepare(`SELECT id FROM users WHERE role = 'admin'`).get();
  if (!adminExists) {
    const adminId = randomUUID();
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'claudio-admin-2026', 10);
    systemDb.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, username, role, created_at)
      VALUES (?, ?, ?, ?, 'admin', ?)
    `).run(adminId, 'admin@claudio.local', hash, 'admin', Date.now());
    console.log('[DB] Admin created: admin@claudio.local / password from ADMIN_PASSWORD env');
  }

  return systemDb;
}

export function initUserDir(uid) {
  const userDir = path.join(DATA_DIR, 'users', uid);
  fs.mkdirSync(userDir, { recursive: true });

  const db = new Database(path.join(userDir, 'state.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plays (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id   TEXT,
      song_name TEXT,
      artist    TEXT,
      played_at INTEGER,
      source    TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS plan (
      date         TEXT PRIMARY KEY,
      content      TEXT,
      generated_at INTEGER
    );
  `);

  db.close();
  userDbs.delete(uid);

  fs.writeFileSync(
    path.join(userDir, 'taste.md'),
    '# My Taste\n\n_Tell Claudio about your music taste here._\n'
  );
  fs.writeFileSync(
    path.join(userDir, 'routines.md'),
    '# My Routines\n\n_Describe your daily routines and when you listen to music._\n'
  );
}

export function getUserDb(uid) {
  if (userDbs.has(uid)) return userDbs.get(uid);

  const dbPath = path.join(DATA_DIR, 'users', uid, 'state.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  userDbs.set(uid, db);
  return db;
}
