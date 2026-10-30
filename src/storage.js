'use strict';
// Uploaded images. With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY they go to a public Supabase
// Storage bucket; otherwise to the local uploads/ folder (tests, Codespaces, local runs).
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const { token } = require('./utils');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'store-media';
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif']);

// Netlify Functions accept request bodies up to about 6 MB, so keep uploads under that there.
const MAX_BYTES = (useSupabase ? 4 : 8) * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 20 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.has(path.extname(file.originalname).toLowerCase())),
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const supabaseHeaders = (extra = {}) => ({ Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, ...extra });

async function supabase(method, urlPath, body, headers) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${urlPath}`, { method, headers: supabaseHeaders(headers), body });
  if (!res.ok) throw new Error(`Supabase Storage ${method} ${urlPath} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Creates the public bucket the first time it's needed, so there's nothing to set up by hand.
let bucketReady;
function ensureBucket() {
  bucketReady = bucketReady || (async () => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: supabaseHeaders() });
    if (res.ok) return;
    await supabase('POST', 'bucket', JSON.stringify({ id: BUCKET, name: BUCKET, public: true }), { 'Content-Type': 'application/json' });
  })().catch((err) => { bucketReady = null; throw err; });
  return bucketReady;
}

const publicUrl = (name) => (useSupabase ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${name}` : `/uploads/${name}`);

// Saves a multer file and returns its public URL ('' when there is no file).
async function saveFile(file) {
  if (!file) return '';
  const name = token(10) + path.extname(file.originalname).toLowerCase();
  if (useSupabase) {
    await ensureBucket();
    await supabase('POST', `object/${BUCKET}/${name}`, file.buffer, { 'Content-Type': file.mimetype, 'Cache-Control': '604800' });
  } else {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  }
  return publicUrl(name);
}

const saveFiles = (files = []) => Promise.all(files.map(saveFile));

async function listFiles() {
  if (useSupabase) {
    await ensureBucket();
    const items = await supabase('POST', `object/list/${BUCKET}`, JSON.stringify({
      prefix: '', limit: 1000, sortBy: { column: 'created_at', order: 'desc' },
    }), { 'Content-Type': 'application/json' });
    return items.filter((i) => i.id).map((i) => ({
      name: i.name, url: publicUrl(i.name), size: (i.metadata && i.metadata.size) || 0, created: new Date(i.created_at),
    }));
  }
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).filter((f) => !f.startsWith('.')).map((name) => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, url: publicUrl(name), size: stat.size, created: stat.mtime };
  }).sort((a, b) => b.created - a.created);
}

async function removeFile(name) {
  const safe = path.basename(String(name || ''));
  if (!safe) return;
  if (useSupabase) {
    await supabase('DELETE', `object/${BUCKET}`, JSON.stringify({ prefixes: [safe] }), { 'Content-Type': 'application/json' });
  } else if (fs.existsSync(path.join(UPLOAD_DIR, safe))) {
    fs.unlinkSync(path.join(UPLOAD_DIR, safe));
  }
}

module.exports = { upload, csvUpload, saveFile, saveFiles, listFiles, removeFile, useSupabase, UPLOAD_DIR, MAX_BYTES };
