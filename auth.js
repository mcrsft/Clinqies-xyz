const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { getDb, audit, getSetting } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_OPTS = {
  httpOnly: true, secure: true, sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password, invite } = req.body;
  if (!username || !email || !password || !invite) return res.status(400).json({ error: 'all fields required' });
  if (username.length < 3 || username.length > 24 || !/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'username must be 3-24 alphanumeric chars' });
  if (password.length < 10) return res.status(400).json({ error: 'password must be at least 10 characters' });

  const db = getDb();
  const inv = db.prepare(`SELECT * FROM invites WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > strftime('%s','now'))`).get(invite.trim());
  if (!inv) return res.status(400).json({ error: 'invalid or expired invite code' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(409).json({ error: 'username or email already taken' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const apiKey = 'clq_' + nanoid(32);
    const isFirstUser = !db.prepare('SELECT id FROM users LIMIT 1').get();
    const defaultQuota = parseInt(getSetting('default_quota') || '2147483648');

    const result = db.prepare(`
      INSERT INTO users (username, email, password, api_key, role, storage_quota)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, email.toLowerCase(), hash, apiKey, isFirstUser ? 'admin' : 'user', defaultQuota);

    db.prepare('UPDATE invites SET used_by = ?, used_at = strftime(\'%s\',\'now\') WHERE id = ?').run(result.lastInsertRowid, inv.id);
    audit(db, result.lastInsertRowid, username, 'register', null, req.ip);

    res.json({ success: true, message: 'account created, please log in' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password, totp } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'credentials required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  if (user.suspended) return res.status(403).json({ error: 'account suspended' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    audit(db, user.id, user.username, 'login_fail', 'invalid password', req.ip);
    return res.status(401).json({ error: 'invalid credentials' });
  }

  if (user.totp_enabled) {
    if (!totp) return res.status(200).json({ requires2fa: true });
    const verified = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: totp, window: 1 });
    if (!verified) return res.status(401).json({ error: 'invalid 2fa code' });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, COOKIE_OPTS);
  audit(db, user.id, user.username, 'login', null, req.ip);

  res.json({
    success: true,
    user: {
      id: user.id, username: user.username, email: user.email, role: user.role,
      api_key: user.api_key, totp_enabled: !!user.totp_enabled,
      storage_used: user.storage_used, storage_quota: user.storage_quota
    },
    motd: getSetting('motd') || ''
  });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  audit(getDb(), req.user.id, req.user.username, 'logout', null, req.ip);
  res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, email: u.email, role: u.role,
    api_key: u.api_key, totp_enabled: !!u.totp_enabled,
    storage_used: u.storage_used, storage_quota: u.storage_quota,
    created_at: u.created_at, last_seen: u.last_seen,
    motd: getSetting('motd') || ''
  });
});

// POST /api/auth/2fa/setup
router.post('/2fa/setup', requireAuth, async (req, res) => {
  const secret = speakeasy.generateSecret({ name: `clinqies.xyz (${req.user.username})`, length: 20 });
  getDb().prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, req.user.id);
  const qrUrl = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qr: qrUrl });
});

// POST /api/auth/2fa/confirm
router.post('/2fa/confirm', requireAuth, (req, res) => {
  const { token } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_secret) return res.status(400).json({ error: '2fa setup not started' });
  const verified = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token, window: 1 });
  if (!verified) return res.status(400).json({ error: 'invalid code' });
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  audit(db, req.user.id, req.user.username, '2fa_enabled', null, req.ip);
  res.json({ success: true });
});

// DELETE /api/auth/2fa
router.delete('/2fa', requireAuth, async (req, res) => {
  const { password } = req.body;
  const valid = await bcrypt.compare(password, req.user.password);
  if (!valid) return res.status(401).json({ error: 'invalid password' });
  const db = getDb();
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  audit(db, req.user.id, req.user.username, '2fa_disabled', null, req.ip);
  res.json({ success: true });
});

// POST /api/auth/apikey/regen
router.post('/apikey/regen', requireAuth, async (req, res) => {
  const { password } = req.body;
  const valid = await bcrypt.compare(password, req.user.password);
  if (!valid) return res.status(401).json({ error: 'invalid password' });
  const newKey = 'clq_' + nanoid(32);
  getDb().prepare('UPDATE users SET api_key = ? WHERE id = ?').run(newKey, req.user.id);
  audit(getDb(), req.user.id, req.user.username, 'apikey_regen', null, req.ip);
  res.json({ success: true, api_key: newKey });
});

// DELETE /api/auth/account — self-delete account
router.delete('/account', requireAuth, async (req, res) => {
  const { password, confirm } = req.body;
  if (confirm !== 'DELETE MY ACCOUNT') return res.status(400).json({ error: 'confirmation text incorrect' });

  const valid = await bcrypt.compare(password, req.user.password);
  if (!valid) return res.status(401).json({ error: 'invalid password' });

  const db = getDb();

  // Delete physical files
  const path = require('path');
  const fs = require('fs');
  const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

  const files = db.prepare('SELECT filename FROM files WHERE user_id = ? AND deleted = 0').all(req.user.id);
  files.forEach(f => fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {}));

  // Log before delete (user ref will be null after)
  audit(db, req.user.id, req.user.username, 'account_deleted', 'self-deletion', req.ip);

  // Delete user (cascade deletes files, short_urls, galleries)
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);

  res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ success: true });
});

module.exports = router;
