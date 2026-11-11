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

// New-style secret keys (sb_secret_...) go only in the apikey header; Supabase's gateway rejects
// them as a Bearer token. Legacy service_role keys are JWTs and go in both.
const supabaseHeaders = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  ...(SUPABASE_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SUPABASE_KEY}` }),
  ...extra,
});

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

/* ---------- Private files (clinic) ----------
 * Never public: a private Supabase bucket (read with the service key, server-side only), or a local
 * folder that is not served over HTTP. Callers encrypt the bytes before saving (see vault.js). */
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'clinic-private';
const PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'private-uploads');
const PRIVATE_TYPES = new Map([
  ['.pdf', 'application/pdf'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.heic', 'image/heic'], ['.txt', 'text/plain'], ['.csv', 'text/csv'],
  ['.doc', 'application/msword'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

const privateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => cb(null, PRIVATE_TYPES.has(path.extname(file.originalname).toLowerCase())),
});

let privateBucketReady;
function ensurePrivateBucket() {
  privateBucketReady = privateBucketReady || (async () => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${PRIVATE_BUCKET}`, { headers: supabaseHeaders() });
    if (res.ok) {
      const bucket = await res.json();
      if (bucket.public) throw new Error(`Storage bucket "${PRIVATE_BUCKET}" is public. Make it private in Supabase before storing clinic files.`);
      return;
    }
    await supabase('POST', 'bucket', JSON.stringify({ id: PRIVATE_BUCKET, name: PRIVATE_BUCKET, public: false }), { 'Content-Type': 'application/json' });
  })().catch((err) => { privateBucketReady = null; throw err; });
  return privateBucketReady;
}

const safeKey = (key) => {
  if (!/^[a-z0-9/_-]+$/i.test(key) || key.includes('..')) throw new Error('Invalid private file key.');
  return key;
};

async function savePrivate(key, buffer, { overwrite = false } = {}) {
  safeKey(key);
  if (useSupabase) {
    await ensurePrivateBucket();
    await supabase('POST', `object/${PRIVATE_BUCKET}/${key}`, buffer, { 'Content-Type': 'application/octet-stream', ...(overwrite ? { 'x-upsert': 'true' } : {}) });
    return;
  }
  const file = path.join(PRIVATE_DIR, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer, { mode: 0o600 });
}

async function readPrivate(key) {
  safeKey(key);
  if (useSupabase) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${PRIVATE_BUCKET}/${key}`, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Private file read failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(path.join(PRIVATE_DIR, key));
}

async function removePrivate(key) {
  safeKey(key);
  if (useSupabase) {
    await supabase('DELETE', `object/${PRIVATE_BUCKET}`, JSON.stringify({ prefixes: [key] }), { 'Content-Type': 'application/json' });
  } else if (fs.existsSync(path.join(PRIVATE_DIR, key))) {
    fs.unlinkSync(path.join(PRIVATE_DIR, key));
  }
}

Object.assign(module.exports, { privateUpload, savePrivate, readPrivate, removePrivate, PRIVATE_TYPES });
