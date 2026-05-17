require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { initDb } = require('./utils/db');
const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const filesRoutes = require('./routes/files');
const adminRoutes = require('./routes/admin');
const configRoutes = require('./routes/config');
const shortRoutes = require('./routes/short');
const galleryRoutes = require('./routes/gallery');

const app = express();
const PORT = process.env.PORT || 3000;

initDb();

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || 'https://clinqies.xyz', credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'too many attempts' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'rate limit exceeded' } });

// Uploaded files
app.use('/f', express.static(path.join(__dirname, '../uploads'), {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// Frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Short URL redirect (before API routes)
app.use('/s', shortRoutes);

// Public gallery page redirect
app.get('/g/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// API
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/upload', uploadLimiter, uploadRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);
app.use('/api/short', shortRoutes);
app.use('/api/gallery', galleryRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[clinqies] server running on 127.0.0.1:${PORT}`);
});
