const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/clinqies.db');

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL COLLATE NOCASE,
      email       TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password    TEXT NOT NULL,
      api_key     TEXT UNIQUE NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER DEFAULT 0,
      passkey_id  TEXT,
      passkey_pub TEXT,
      role        TEXT DEFAULT 'user',
      storage_used INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (unixepoch()),
      last_seen   INTEGER
    );

    CREATE TABLE IF NOT EXISTS invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      used_by    INTEGER REFERENCES users(id),
      used_at    INTEGER,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size         INTEGER NOT NULL,
      views        INTEGER DEFAULT 0,
      deleted      INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  console.log('[db] initialized');
  return db;
}

// Prepared statement helpers
const stmts = {};

function prepare(name, sql) {
  if (!stmts[name]) stmts[name] = getDb().prepare(sql);
  return stmts[name];
}

module.exports = { getDb, initDb, prepare };
