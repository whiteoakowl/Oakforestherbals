'use strict';
// Application-level encryption for clinical data (AES-256-GCM). Clinical text and uploaded files
// are encrypted here, before they reach Postgres or Supabase Storage, so the database, its backups
// and the storage bucket only ever hold ciphertext. Only this server, holding the key, can read it.
//
// Key: CLINIC_ENCRYPTION_KEY — 32 random bytes as 64 hex characters or base64. Generate one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// and keep a copy somewhere safe outside Netlify (a password manager). If the key is lost,
// encrypted records cannot be recovered by anyone.
//
// Without a key: on a deployed site (DATABASE_URL set) clinic features refuse to run; locally and in
// tests a key is generated into data/.clinic-key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 'v1';

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('CLINIC_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).');
  return buf;
}

let cached;
function key() {
  if (cached !== undefined) return cached;
  if (process.env.CLINIC_ENCRYPTION_KEY) {
    cached = parseKey(process.env.CLINIC_ENCRYPTION_KEY);
  } else if (process.env.DATABASE_URL && !process.env.ALLOW_LOCAL_CLINIC_KEY) {
    cached = null;
  } else {
    const file = path.join(__dirname, '..', 'data', '.clinic-key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    cached = parseKey(fs.readFileSync(file, 'utf8'));
  }
  return cached;
}

const configured = () => Boolean(key());

function requireKey() {
  const k = key();
  if (!k) throw Object.assign(new Error('Clinic records are locked: CLINIC_ENCRYPTION_KEY is not set on this site.'), { status: 503 });
  return k;
}

// Buffer -> Buffer laid out as [12-byte IV][16-byte tag][ciphertext].
function sealBuffer(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', requireKey(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openBuffer(sealed) {
  const buf = Buffer.from(sealed);
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// Any JSON value -> "v1:<base64>" text, and back. null/undefined stay null.
function seal(value) {
  if (value === null || value === undefined) return null;
  return `${VERSION}:${sealBuffer(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64')}`;
}

function open(text) {
  if (text === null || text === undefined || text === '') return null;
  const [version, data] = String(text).split(':');
  if (version !== VERSION || !data) throw new Error('Unrecognised encrypted value.');
  return JSON.parse(openBuffer(Buffer.from(data, 'base64')).toString('utf8'));
}

// For tests only.
function resetForTests() { cached = undefined; }

module.exports = { seal, open, sealBuffer, openBuffer, configured, requireKey, parseKey, resetForTests };
