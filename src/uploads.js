'use strict';
// Image uploads saved to /uploads with random file names.
const path = require('node:path');
const multer = require('multer');
const { token } = require('./utils');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, token(10) + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.has(path.extname(file.originalname).toLowerCase())),
});

// CSV imports are read in memory rather than written to disk.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const fileUrl = (file) => (file ? `/uploads/${file.filename}` : '');

module.exports = { upload, csvUpload, fileUrl, UPLOAD_DIR };
