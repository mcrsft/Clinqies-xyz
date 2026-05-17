const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../utils/db');
const { requireAuth, requireAuthOrApiKey } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

// GET /api/files
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, sort = 'created_at', order = 'desc' } = req.query;

  const allowedSort = ['created_at', 'size', 'views', 'original_name'];
  const allowedOrder = ['asc', 'desc'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';
  const safeOrder = allowedOrder.includes(order) ? order : 'desc';
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const files = db.prepare(`
    SELECT id, filename, original_name, mime_type, size, views, created_at, expires_at
    FROM files
    WHERE user_id = ? AND deleted = 0
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `).all(req.user.id, parseInt(limit), offset);

  const total = db.prepare('SELECT COUNT(*) as c FROM files WHERE user_id = ? AND deleted = 0').get(req.user.id).c;
  const base = process.env.BASE_URL || 'https://clinqies.xyz';

  res.json({
    files: files.map(f => ({ ...f, url: `${base}/f/${f.filename}` })),
    total,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

// GET /api/files/stats
router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT COUNT(*) as file_count, SUM(size) as total_size, SUM(views) as total_views, MAX(created_at) as last_upload
    FROM files WHERE user_id = ? AND deleted = 0
  `).get(req.user.id);

  const globalSize = db.prepare('SELECT SUM(size) as total FROM files WHERE deleted = 0').get()?.total || 0;

  res.json({
    file_count: stats.file_count || 0,
    total_size: stats.total_size || 0,
    total_views: stats.total_views || 0,
    last_upload: stats.last_upload,
    global_used: globalSize,
    global_quota: 1099511627776
  });
});

// DELETE /api/files/:id
router.delete('/:id', requireAuthOrApiKey, (req, res) => {
  const db = getDb();
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'file not found' });
  if (file.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);
  db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(file.size, file.user_id);

  fs.unlink(path.join(UPLOAD_DIR, file.filename), (err) => {
    if (err && err.code !== 'ENOENT') console.error('[delete] unlink error:', err.message);
  });

  res.json({ success: true });
});

// DELETE /api/files/bulk — bulk delete
router.delete('/', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'no ids provided' });

  const db = getDb();
  let deleted = 0;

  ids.forEach(id => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(id);
    if (!file) return;
    if (file.user_id !== req.user.id && req.user.role !== 'admin') return;

    db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);
    db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(file.size, file.user_id);
    fs.unlink(path.join(UPLOAD_DIR, file.filename), () => {});
    deleted++;
  });

  res.json({ success: true, deleted });
});

// PATCH /api/files/:id/expiry — set/update expiry
router.patch('/:id/expiry', requireAuth, (req, res) => {
  const { expires_in_hours } = req.body;
  const db = getDb();
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });
  if (file.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

  const expiresAt = expires_in_hours ? Math.floor(Date.now() / 1000) + parseInt(expires_in_hours) * 3600 : null;
  db.prepare('UPDATE files SET expires_at = ? WHERE id = ?').run(expiresAt, file.id);
  res.json({ success: true, expires_at: expiresAt });
});

module.exports = router;
