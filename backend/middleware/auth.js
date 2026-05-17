const jwt = require('jsonwebtoken');
const { getDb } = require('../utils/db');

const JWT_SECRET = process.env.JWT_SECRET;

function requireAuth(req, res, next) {
  const token = req.cookies?.token || extractBearer(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'user not found' });
    req.user = user;
    db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(user.id);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key) return res.status(401).json({ error: 'api key required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(key);
  if (!user) return res.status(401).json({ error: 'invalid api key' });

  req.user = user;
  db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(user.id);
  next();
}

function requireAuthOrApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function extractBearer(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

module.exports = { requireAuth, requireApiKey, requireAuthOrApiKey, requireAdmin };
