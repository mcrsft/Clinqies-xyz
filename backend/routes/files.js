const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getDb, audit } = require('../utils/db');
const { requireAuth, requireAuthOrApiKey } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

// GET /api/files
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, sort = 'created_at', order = 'desc', search = '' } = req.query;

  const allowedSort = ['created_at', 'size', 'views', 'original_name'];
  const allowedOrder = ['asc', 'desc'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';
  const safeOrder = allowedOrder.includes(order) ? order : 'desc';
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const searchClause = search ? `AND original_name LIKE '%' || ? || '%'` : '';
  const params = search
    ? [req.user.id, search, parseInt(limit), offset]
    : [req.user.id, parseInt(limit), offset];

  const files = db.prepare(`
    SELECT id, filename, original_name, mime_type, size, views, created_at, expires_at,
           CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as password_protected
    FROM files
    WHERE user_id = ? AND deleted = 0 ${searchClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `).all(...params);

  const countParams = search ? [req.user.id, search] : [req.user.id];
  const total = db.prepare(`
    SELECT COUNT(*) as c FROM files WHERE user_id = ? AND deleted = 0 ${searchClause}
  `).get(...countParams).c;

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({
    files: files.map(f => ({ ...f, url: `${base}/f/${f.filename}`, view_url: `${base}/v/${f.filename}` })),
    total, page: parseInt(page), limit: parseInt(limit)
  });
});

// GET /api/files/stats
router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT COUNT(*) as file_count, SUM(size) as total_size, SUM(views) as total_views
    FROM files WHERE user_id = ? AND deleted = 0
  `).get(req.user.id);

  const globalSize = db.prepare('SELECT SUM(size) as total FROM files WHERE deleted = 0').get()?.total || 0;
  const user = db.prepare('SELECT storage_used, storage_quota FROM users WHERE id = ?').get(req.user.id);

  res.json({
    file_count: stats.file_count || 0,
    total_size: stats.total_size || 0,
    total_views: stats.total_views || 0,
    global_used: globalSize,
    global_quota: 1099511627776,
    user_used: user.storage_used || 0,
    user_quota: user.storage_quota || 2147483648
  });
});

// GET /api/files/view/:filename — public file metadata for viewer page
router.get('/view/:filename', (req, res) => {
  const db = getDb();
  const file = db.prepare(`
    SELECT f.id, f.filename, f.original_name, f.mime_type, f.size, f.views, f.created_at,
           f.expires_at, f.password_hash, u.username
    FROM files f JOIN users u ON u.id = f.user_id
    WHERE f.filename = ? AND f.deleted = 0
  `).get(req.params.filename);

  if (!file) return res.status(404).json({ error: 'not found' });

  // Check expiry
  if (file.expires_at && file.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(410).json({ error: 'file has expired' });
  }

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({
    id: file.id,
    filename: file.filename,
    original_name: file.original_name,
    mime_type: file.mime_type,
    size: file.size,
    views: file.views,
    created_at: file.created_at,
    expires_at: file.expires_at,
    uploader: file.username,
    url: `${base}/f/${file.filename}`,
    password_protected: !!file.password_hash
  });
});

// POST /api/files/view/:filename/unlock — check password for protected files
router.post('/view/:filename/unlock', async (req, res) => {
  const { password } = req.body;
  const db = getDb();
  const file = db.prepare('SELECT password_hash FROM files WHERE filename = ? AND deleted = 0').get(req.params.filename);
  if (!file) return res.status(404).json({ error: 'not found' });
  if (!file.password_hash) return res.json({ success: true });

  const valid = await bcrypt.compare(password || '', file.password_hash);
  if (!valid) return res.status(401).json({ error: 'incorrect password' });

  // Increment views on successful unlock
  db.prepare('UPDATE files SET views = views + 1 WHERE filename = ?').run(req.params.filename);
  res.json({ success: true });
});

// DELETE /api/files/:id
router.delete('/:id', requireAuthOrApiKey, (req, res) => {
  const db = getDb();
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'file not found' });
  if (file.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);
  db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(file.size, file.user_id);
  audit(db, req.user.id, req.user.username, 'delete', file.original_name, req.ip);

  fs.unlink(path.join(UPLOAD_DIR, file.filename), (err) => {
    if (err && err.code !== 'ENOENT') console.error('[delete] unlink error:', err.message);
  });

  res.json({ success: true });
});

// DELETE /api/files — bulk delete
router.delete('/', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'no ids provided' });

  const db = getDb();
  let deleted = 0;

  ids.forEach(id => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(id);
    if (!file || (file.user_id !== req.user.id && req.user.role !== 'admin')) return;
    db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);
    db.prepare('UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?').run(file.size, file.user_id);
    fs.unlink(path.join(UPLOAD_DIR, file.filename), () => {});
    deleted++;
  });

  audit(db, req.user.id, req.user.username, 'bulk_delete', `${deleted} files`, req.ip);
  res.json({ success: true, deleted });
});

// PATCH /api/files/:id/expiry
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
