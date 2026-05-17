const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const mime = require('mime-types');
const bcrypt = require('bcryptjs');
const { getDb, audit } = require('../utils/db');
const { requireAuthOrApiKey } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const TOTAL_QUOTA = 1024 * 1024 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  'image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
  'video/mp4','video/webm','video/quicktime',
  'audio/mpeg','audio/ogg','audio/wav','audio/flac',
  'application/pdf','application/zip','application/x-zip-compressed',
  'text/plain','text/markdown','application/json','application/octet-stream'
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.' + (mime.extension(file.mimetype) || 'bin');
    cb(null, nanoid(10) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const type = file.mimetype.toLowerCase();
    if (ALLOWED_TYPES.has(type) || type.startsWith('image/') || type.startsWith('text/')) cb(null, true);
    else cb(new Error(`file type not allowed: ${type}`));
  }
});

router.post('/', requireAuthOrApiKey, (req, res) => {
  const db = getDb();
  const user = req.user;

  // Check suspended
  if (user.suspended) return res.status(403).json({ error: 'account suspended' });

  // Check global quota
  const totalRow = db.prepare('SELECT SUM(size) as total FROM files WHERE deleted = 0').get();
  if ((totalRow?.total || 0) >= TOTAL_QUOTA) return res.status(507).json({ error: 'server storage quota reached' });

  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large (max 50MB)' });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file provided' });

    const { filename, originalname, mimetype, size } = req.file;

    // Check per-user quota
    const freshUser = db.prepare('SELECT storage_used, storage_quota FROM users WHERE id = ?').get(user.id);
    if (freshUser.storage_used + size > freshUser.storage_quota) {
      fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
      return res.status(507).json({ error: `storage quota exceeded (${formatBytes(freshUser.storage_quota)} limit)` });
    }

    // Expiry
    const expiresHours = req.query.expires_in_hours || req.headers['x-expires-hours'] || req.body.expires_in_hours;
    const expiresAt = expiresHours ? Math.floor(Date.now() / 1000) + parseInt(expiresHours) * 3600 : null;

    // Password protection
    const filePassword = req.query.password || req.headers['x-file-password'] || req.body.file_password;
    let passwordHash = null;
    if (filePassword) {
      passwordHash = await bcrypt.hash(filePassword, 10);
    }

    const result = db.prepare(`
      INSERT INTO files (user_id, filename, original_name, mime_type, size, expires_at, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, filename, originalname, mimetype, size, expiresAt, passwordHash);

    db.prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?').run(size, user.id);
    audit(db, user.id, user.username, 'upload', `${originalname} (${formatBytes(size)})`, req.ip);

    const base = process.env.BASE_URL || 'https://clinqies.xyz';
    res.json({
      success: true,
      url: `${base}/f/${filename}`,
      view_url: `${base}/v/${filename}`,
      deletion_url: `${base}/api/files/${result.lastInsertRowid}`,
      filename, size, id: result.lastInsertRowid, expires_at: expiresAt,
      password_protected: !!passwordHash
    });
  });
});

function formatBytes(b) {
  if (!b) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

module.exports = router;
