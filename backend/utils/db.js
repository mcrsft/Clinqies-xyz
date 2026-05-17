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
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
      email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password      TEXT NOT NULL,
      api_key       TEXT UNIQUE NOT NULL,
      totp_secret   TEXT,
      totp_enabled  INTEGER DEFAULT 0,
      role          TEXT DEFAULT 'user',
      storage_used  INTEGER DEFAULT 0,
      storage_quota INTEGER DEFAULT 10737418240,
      suspended     INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (strftime('%s','now')),
      last_seen     INTEGER
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
      password_hash TEXT,
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username   TEXT,
      action     TEXT NOT NULL,
      detail     TEXT,
      ip         TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_short_code ON short_urls(code);
    CREATE INDEX IF NOT EXISTS idx_gallery_code ON galleries(code);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);

  // Migrations — safe to run on existing DB
  const migrations = [
    'ALTER TABLE users ADD COLUMN storage_quota INTEGER DEFAULT 10737418240',
    'ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN expires_at INTEGER',
    'ALTER TABLE files ADD COLUMN password_hash TEXT',
  ];
  migrations.forEach(sql => { try { db.exec(sql); } catch (e) {} });

  // Default settings
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('motd', '')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_quota', '10737418240')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_open', '0')").run();

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

function audit(db, userId, username, action, detail, ip) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(userId, username, action, detail || null, ip || null);
  } catch (e) {}
}

function getSetting(key) {
  const db = getDb();
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = { getDb, initDb, cleanupExpired, audit, getSetting, setSetting };
