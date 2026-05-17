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

const app = express();
const PORT = process.env.PORT || 3000;

// Init DB on startup
initDb();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // handled by nginx
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS — only clinqies.xyz
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'https://clinqies.xyz',
  credentials: true
}));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: 'too many attempts, try again later' }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  message: { error: 'upload rate limit exceeded' }
});

// Serve uploaded files
app.use('/f', express.static(path.join(__dirname, '../uploads'), {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// API routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/upload', uploadLimiter, uploadRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[clinqies] server running on 127.0.0.1:${PORT}`);
});
