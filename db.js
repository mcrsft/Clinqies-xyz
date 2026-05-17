const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/clinqies.db');
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
      role        TEXT DEFAULT 'user',
      storage_used INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (strftime('%s','now')),
      last_seen   INTEGER
    );

    CREATE TABLE IF NOT EXISTS invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      used_by    INTEGER REFERENCES users(id),
      used_at    INTEGER,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      views         INTEGER DEFAULT 0,
      deleted       INTEGER DEFAULT 0,
      expires_at    INTEGER,
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS short_urls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      target_url TEXT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      clicks     INTEGER DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS galleries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT DEFAULT 'gallery',
      file_ids   TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_short_code ON short_urls(code);
    CREATE INDEX IF NOT EXISTS idx_gallery_code ON galleries(code);
  `);

  // Migrate: add expires_at to files if missing
  try {
    db.exec('ALTER TABLE files ADD COLUMN expires_at INTEGER');
  } catch (e) {}

  setInterval(cleanupExpired, 10 * 60 * 1000);
  console.log('[db] initialized');
  return db;
}

function cleanupExpired() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

  const expiredFiles = db.prepare(
    'SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted = 0'
  ).all(now);

  expiredFiles.forEach(f => {
    db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(f.id);
    db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(f.size, f.user_id);
    fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {});
  });

  if (expiredFiles.length) console.log(`[cleanup] expired ${expiredFiles.length} file(s)`);

  db.prepare('DELETE FROM short_urls WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  db.prepare('DELETE FROM galleries WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
}

module.exports = { getDb, initDb, cleanupExpired };
