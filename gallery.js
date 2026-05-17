const router = require('express').Router();
const { nanoid } = require('nanoid');
const { getDb } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

// POST /api/gallery — create a public gallery link
router.post('/', requireAuth, (req, res) => {
  const { name, file_ids, expires_in_hours } = req.body;
  if (!file_ids || !file_ids.length) return res.status(400).json({ error: 'no files selected' });

  const db = getDb();
  const code = nanoid(10);
  const expiresAt = expires_in_hours ? Math.floor(Date.now() / 1000) + parseInt(expires_in_hours) * 3600 : null;

  db.prepare(`
    INSERT INTO galleries (code, user_id, name, file_ids, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, req.user.id, name || 'gallery', JSON.stringify(file_ids), expiresAt);

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({ code, gallery_url: `${base}/g/${code}` });
});

// GET /api/gallery/:code — get gallery data (public)
router.get('/:code', (req, res) => {
  const db = getDb();
  const gallery = db.prepare(`
    SELECT * FROM galleries WHERE code = ? AND (expires_at IS NULL OR expires_at > unixepoch())
  `).get(req.params.code);

  if (!gallery) return res.status(404).json({ error: 'gallery not found or expired' });

  const fileIds = JSON.parse(gallery.file_ids);
  const base = process.env.BASE_URL || 'https://clinqies.xyz';

  const placeholders = fileIds.map(() => '?').join(',');
  const files = db.prepare(`
    SELECT id, filename, original_name, mime_type, size, views, created_at
    FROM files WHERE id IN (${placeholders}) AND deleted = 0
  `).all(...fileIds);

  const mapped = files.map(f => ({ ...f, url: `${base}/f/${f.filename}` }));

  res.json({
    code: gallery.code,
    name: gallery.name,
    files: mapped,
    expires_at: gallery.expires_at,
    created_at: gallery.created_at
  });
});

// GET /api/gallery — list user's galleries
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const galleries = db.prepare('SELECT * FROM galleries WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({ galleries: galleries.map(g => ({ ...g, gallery_url: `${base}/g/${g.code}` })) });
});

// DELETE /api/gallery/:id
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT * FROM galleries WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM galleries WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
