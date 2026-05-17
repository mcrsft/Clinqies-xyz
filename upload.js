const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const mime = require('mime-types');
const { getDb } = require('../utils/db');
const { requireAuthOrApiKey } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const TOTAL_QUOTA = 1024 * 1024 * 1024 * 1024; // 1TB in bytes

// Allowed MIME types
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac',
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'text/plain', 'text/markdown', 'application/json',
  'application/octet-stream'
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.' + (mime.extension(file.mimetype) || 'bin');
    const id = nanoid(10);
    cb(null, id + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const type = file.mimetype.toLowerCase();
    if (ALLOWED_TYPES.has(type) || type.startsWith('image/') || type.startsWith('text/')) {
      cb(null, true);
    } else {
      cb(new Error(`file type not allowed: ${type}`));
    }
  }
});

// POST /api/upload
router.post('/', requireAuthOrApiKey, (req, res) => {
  const db = getDb();

  // Check global quota
  const totalRow = db.prepare('SELECT SUM(size) as total FROM files WHERE deleted = 0').get();
  const totalUsed = totalRow?.total || 0;
  if (totalUsed >= TOTAL_QUOTA) {
    return res.status(507).json({ error: 'server storage quota reached' });
  }

  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file too large (max 50MB)' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file provided' });

    const { filename, originalname, mimetype, size } = req.file;

    // Insert file record
    const result = db.prepare(`
      INSERT INTO files (user_id, filename, original_name, mime_type, size)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, filename, originalname, mimetype, size);

    // Update user storage
    db.prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?').run(size, req.user.id);

    const base = process.env.BASE_URL || 'https://clinqies.xyz';
    const url = `${base}/f/${filename}`;

    // ShareX-compatible response
    res.json({
      success: true,
      url,
      deletion_url: `${base}/api/files/${result.lastInsertRowid}`,
      filename,
      size,
      id: result.lastInsertRowid
    });
  });
});

module.exports = router;
