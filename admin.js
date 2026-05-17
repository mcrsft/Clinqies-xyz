const router = require('express').Router();
const { nanoid } = require('nanoid');
const { getDb, audit, getSetting, setSetting } = require('../utils/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth, requireAdmin);

// POST /api/admin/invites
router.post('/invites', (req, res) => {
  const { count = 1, expires_in_days } = req.body;
  const db = getDb();
  const codes = [];
  const expiresAt = expires_in_days ? Math.floor(Date.now() / 1000) + parseInt(expires_in_days) * 86400 : null;
  const stmt = db.prepare('INSERT INTO invites (code, created_by, expires_at) VALUES (?, ?, ?)');
  const batch = db.transaction(() => {
    for (let i = 0; i < Math.min(parseInt(count), 50); i++) {
      const code = nanoid(16);
      stmt.run(code, req.user.id, expiresAt);
      codes.push(code);
    }
  });
  batch();
  res.json({ success: true, codes, expires_at: expiresAt });
});

// GET /api/admin/invites
router.get('/invites', (req, res) => {
  const db = getDb();
  const invites = db.prepare(`
    SELECT i.*, u.username as created_by_name, u2.username as used_by_name
    FROM invites i
    LEFT JOIN users u ON u.id = i.created_by
    LEFT JOIN users u2 ON u2.id = i.used_by
    ORDER BY i.created_at DESC
  `).all();
  res.json({ invites });
});

// DELETE /api/admin/invites/:id
router.delete('/invites/:id', (req, res) => {
  const db = getDb();
  const inv = db.prepare('SELECT id FROM invites WHERE id = ? AND used_by IS NULL').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'invite not found or already used' });
  db.prepare('DELETE FROM invites WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/users
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.storage_used, u.storage_quota,
           u.suspended, u.totp_enabled, u.created_at, u.last_seen,
           COUNT(f.id) as file_count
    FROM users u
    LEFT JOIN files f ON f.user_id = u.id AND f.deleted = 0
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ users });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  audit(db, req.user.id, req.user.username, 'admin_delete_user', user.username, req.ip);
  res.json({ success: true });
});

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  const db = getDb();
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  audit(db, req.user.id, req.user.username, 'admin_role_change', `user ${req.params.id} → ${role}`, req.ip);
  res.json({ success: true });
});

// PATCH /api/admin/users/:id/quota
router.patch('/users/:id/quota', (req, res) => {
  const { quota_gb } = req.body;
  if (!quota_gb || isNaN(quota_gb)) return res.status(400).json({ error: 'invalid quota' });
  const quotaBytes = Math.round(parseFloat(quota_gb) * 1024 * 1024 * 1024);
  const db = getDb();
  db.prepare('UPDATE users SET storage_quota = ? WHERE id = ?').run(quotaBytes, req.params.id);
  audit(db, req.user.id, req.user.username, 'admin_quota_change', `user ${req.params.id} → ${quota_gb}GB`, req.ip);
  res.json({ success: true, quota_bytes: quotaBytes });
});

// PATCH /api/admin/users/:id/suspend
router.patch('/users/:id/suspend', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot suspend yourself' });
  const { suspended } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, req.params.id);
  audit(db, req.user.id, req.user.username, suspended ? 'admin_suspend' : 'admin_unsuspend', `user ${req.params.id}`, req.ip);
  res.json({ success: true });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as user_count,
      (SELECT COUNT(*) FROM files WHERE deleted = 0) as file_count,
      (SELECT COALESCE(SUM(size),0) FROM files WHERE deleted = 0) as total_size,
      (SELECT COUNT(*) FROM invites WHERE used_by IS NULL AND (expires_at IS NULL OR expires_at > strftime('%s','now'))) as pending_invites
  `).get();
  res.json(stats);
});

// GET /api/admin/storage-chart — per-user storage breakdown
router.get('/storage-chart', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.username, u.storage_used, u.storage_quota, COUNT(f.id) as file_count
    FROM users u
    LEFT JOIN files f ON f.user_id = u.id AND f.deleted = 0
    GROUP BY u.id
    ORDER BY u.storage_used DESC
    LIMIT 20
  `).all();
  res.json({ users: rows });
});

// GET /api/admin/audit
router.get('/audit', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, user_id } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const where = user_id ? 'WHERE user_id = ?' : '';
  const params = user_id ? [parseInt(user_id), parseInt(limit), offset] : [parseInt(limit), offset];

  const logs = db.prepare(`
    SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params);

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...(user_id ? [parseInt(user_id)] : [])).c;
  res.json({ logs, total, page: parseInt(page) });
});

// GET /api/admin/settings
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

// PATCH /api/admin/settings
router.patch('/settings', (req, res) => {
  const { motd, default_quota_gb, registration_open } = req.body;
  if (motd !== undefined) setSetting('motd', motd);
  if (default_quota_gb !== undefined) setSetting('default_quota', Math.round(parseFloat(default_quota_gb) * 1024 * 1024 * 1024));
  if (registration_open !== undefined) setSetting('registration_open', registration_open ? '1' : '0');
  audit(getDb(), req.user.id, req.user.username, 'admin_settings_change', null, req.ip);
  res.json({ success: true });
});

module.exports = router;
