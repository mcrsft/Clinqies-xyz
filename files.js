const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../utils/db');
const { requireAuth, requireAuthOrApiKey } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

// GET /api/files — list current user's files
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, sort = 'created_at', order = 'desc' } = req.query;

  const allowedSort = ['created_at', 'size', 'views', 'original_name'];
  const allowedOrder = ['asc', 'desc'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';
  const safeOrder = allowedOrder.includes(order) ? order : 'desc';
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const files = db.prepare(`
    SELECT id, filename, original_name, mime_type, size, views, created_at
    FROM files
    WHERE user_id = ? AND deleted = 0
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `).all(req.user.id, parseInt(limit), offset);

  const total = db.prepare('SELECT COUNT(*) as c FROM files WHERE user_id = ? AND deleted = 0').get(req.user.id).c;

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  const mapped = files.map(f => ({
    ...f,
    url: `${base}/f/${f.filename}`
  }));

  res.json({ files: mapped, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/files/stats — user storage stats
router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as file_count,
      SUM(size) as total_size,
      SUM(views) as total_views,
      MAX(created_at) as last_upload
    FROM files
    WHERE user_id = ? AND deleted = 0
  `).get(req.user.id);

  const globalSize = db.prepare('SELECT SUM(size) as total FROM files WHERE deleted = 0').get()?.total || 0;

  res.json({
    file_count: stats.file_count || 0,
    total_size: stats.total_size || 0,
    total_views: stats.total_views || 0,
    last_upload: stats.last_upload,
    global_used: globalSize,
    global_quota: 1099511627776 // 1TB
  });
});

// DELETE /api/files/:id — delete a file
router.delete('/:id', requireAuthOrApiKey, (req, res) => {
  const db = getDb();
  const file = db.prepare(`
    SELECT * FROM files WHERE id = ? AND deleted = 0
  `).get(req.params.id);

  if (!file) return res.status(404).json({ error: 'file not found' });

  // Only owner or admin can delete
  if (file.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Soft delete in DB
  db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);

  // Free storage count
  db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(file.size, file.user_id);

  // Remove physical file
  const filePath = path.join(UPLOAD_DIR, file.filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('[delete] unlink error:', err.message);
  });

  res.json({ success: true });
});

// POST /api/files/:id/view — increment view count (called when file link is visited)
router.post('/:id/view', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE files SET views = views + 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/files/:id/info — public file info (for embed pages)
router.get('/:id/info', (req, res) => {
  const db = getDb();
  const file = db.prepare(`
    SELECT f.id, f.filename, f.original_name, f.mime_type, f.size, f.views, f.created_at,
           u.username
    FROM files f
    JOIN users u ON u.id = f.user_id
    WHERE f.id = ? AND f.deleted = 0
  `).get(req.params.id);

  if (!file) return res.status(404).json({ error: 'not found' });

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({ ...file, url: `${base}/f/${file.filename}` });
});

module.exports = router;
