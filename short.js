const router = require('express').Router();
const { nanoid } = require('nanoid');
const { getDb } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

// GET /api/short/:code — redirect
router.get('/:code', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM short_urls WHERE code = ? AND (expires_at IS NULL OR expires_at > unixepoch())
  `).get(req.params.code);
  if (!row) return res.status(404).send('not found');
  db.prepare('UPDATE short_urls SET clicks = clicks + 1 WHERE id = ?').run(row.id);
  res.redirect(301, row.target_url);
});

// POST /api/short — create short URL
router.post('/', requireAuth, (req, res) => {
  const { url, expires_in_hours } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }

  const db = getDb();
  const code = nanoid(7);
  const expiresAt = expires_in_hours ? Math.floor(Date.now() / 1000) + parseInt(expires_in_hours) * 3600 : null;

  db.prepare(`
    INSERT INTO short_urls (code, target_url, user_id, expires_at) VALUES (?, ?, ?, ?)
  `).run(code, url, req.user.id, expiresAt);

  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({ code, short_url: `${base}/s/${code}`, target_url: url });
});

// GET /api/short — list user's short URLs
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const urls = db.prepare(`
    SELECT * FROM short_urls WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  const base = process.env.BASE_URL || 'https://clinqies.xyz';
  res.json({ urls: urls.map(u => ({ ...u, short_url: `${base}/s/${u.code}` })) });
});

// DELETE /api/short/:id
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM short_urls WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM short_urls WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
