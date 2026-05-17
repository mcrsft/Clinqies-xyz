const router = require('express').Router();
const { nanoid } = require('nanoid');
const { getDb } = require('../utils/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// POST /api/admin/invites — create invite codes
router.post('/invites', (req, res) => {
  const { count = 1, expires_in_days } = req.body;
  const db = getDb();
  const codes = [];

  const expiresAt = expires_in_days
    ? Math.floor(Date.now() / 1000) + parseInt(expires_in_days) * 86400
    : null;

  const stmt = db.prepare(`
    INSERT INTO invites (code, created_by, expires_at) VALUES (?, ?, ?)
  `);

  const batchInsert = db.transaction(() => {
    for (let i = 0; i < Math.min(parseInt(count), 50); i++) {
      const code = nanoid(16);
      stmt.run(code, req.user.id, expiresAt);
      codes.push(code);
    }
  });

  batchInsert();
  res.json({ success: true, codes, expires_at: expiresAt });
});

// GET /api/admin/invites — list all invites
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

// DELETE /api/admin/invites/:id — revoke invite
router.delete('/invites/:id', (req, res) => {
  const db = getDb();
  const inv = db.prepare('SELECT id FROM invites WHERE id = ? AND used_by IS NULL').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'invite not found or already used' });
  db.prepare('DELETE FROM invites WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/users — list all users
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.storage_used, u.totp_enabled,
           u.created_at, u.last_seen,
           COUNT(f.id) as file_count
    FROM users u
    LEFT JOIN files f ON f.user_id = u.id AND f.deleted = 0
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ users });
});

// DELETE /api/admin/users/:id — remove user and their files
router.delete('/users/:id', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'cannot delete yourself' });
  }
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Files are cascade-deleted by FK
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// PATCH /api/admin/users/:id/role — promote/demote
router.patch('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  const db = getDb();
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ success: true });
});

// GET /api/admin/stats — server-wide stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as user_count,
      (SELECT COUNT(*) FROM files WHERE deleted = 0) as file_count,
      (SELECT COALESCE(SUM(size),0) FROM files WHERE deleted = 0) as total_size,
      (SELECT COUNT(*) FROM invites WHERE used_by IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())) as pending_invites
  `).get();
  res.json(stats);
});

module.exports = router;
