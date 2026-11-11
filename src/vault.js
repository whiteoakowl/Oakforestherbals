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

// Values written before key rotation existed are "v1:<base64>"; current ones are
// "v2:<key id>:<base64>", where the key id is the first 8 hex characters of the key's SHA-256,
// so the right key is picked without trial and error. Files carry the same id in a short header.
//
// Rotating the key: set the new key as CLINIC_ENCRYPTION_KEY and the old one as
// CLINIC_ENCRYPTION_KEY_PREVIOUS (comma-separate several), redeploy, then run Settings →
// Encryption → Re-encrypt. When it reports nothing left on old keys, remove the previous key.
const FILE_MAGIC = Buffer.from('OFK2');

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('CLINIC_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).');
  return buf;
}

const keyId = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);

let cached;
let previous;
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

// Older keys still accepted for reading, newest first.
function previousKeys() {
  if (previous === undefined) previous = String(process.env.CLINIC_ENCRYPTION_KEY_PREVIOUS || '').split(',').map((k) => k.trim()).filter(Boolean).map(parseKey);
  return previous;
}

const configured = () => Boolean(key());
const currentKeyId = () => (key() ? keyId(key()) : null);
const knownKeyIds = () => [key(), ...previousKeys()].filter(Boolean).map(keyId);

function requireKey() {
  const k = key();
  if (!k) throw Object.assign(new Error('Clinic records are locked: CLINIC_ENCRYPTION_KEY is not set on this site.'), { status: 503 });
  return k;
}

function allKeys() { return [requireKey(), ...previousKeys()]; }
function keyById(id) { return allKeys().find((k) => keyId(k) === id) || null; }

function encrypt(k, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(k, buf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// Tries each key in turn (for data written before key ids existed).
function decryptAny(buf) {
  let lastErr;
  for (const k of allKeys()) {
    try { return decrypt(k, buf); } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('No key could decrypt this value.');
}

// Buffer -> [OFK2][4-byte key id][12-byte IV][16-byte tag][ciphertext].
function sealBuffer(plain) {
  const k = requireKey();
  return Buffer.concat([FILE_MAGIC, Buffer.from(keyId(k), 'hex'), encrypt(k, plain)]);
}

// Which key a sealed file was written with (null for files from before key ids).
function bufferKeyId(sealed) {
  const buf = Buffer.from(sealed);
  return buf.length > 36 && buf.subarray(0, 4).equals(FILE_MAGIC) ? buf.subarray(4, 8).toString('hex') : null;
}

function openBuffer(sealed) {
  const buf = Buffer.from(sealed);
  const id = bufferKeyId(buf);
  const k = id && keyById(id);
  if (k) {
    try { return decrypt(k, buf.subarray(8)); } catch { /* a legacy file that happens to start with the header */ }
  }
  return decryptAny(buf);
}

// Any JSON value -> "v2:<key id>:<base64>" text, and back. null/undefined stay null.
function seal(value) {
  if (value === null || value === undefined) return null;
  const k = requireKey();
  return `v2:${keyId(k)}:${encrypt(k, Buffer.from(JSON.stringify(value), 'utf8')).toString('base64')}`;
}

function open(text) {
  if (text === null || text === undefined || text === '') return null;
  const parts = String(text).split(':');
  let plain;
  if (parts[0] === 'v2' && parts.length === 3) {
    const k = keyById(parts[1]);
    if (!k) throw new Error('This value was encrypted with a key this site no longer has.');
    plain = decrypt(k, Buffer.from(parts[2], 'base64'));
  } else if (parts[0] === 'v1' && parts.length === 2 && parts[1]) {
    plain = decryptAny(Buffer.from(parts[1], 'base64'));
  } else {
    throw new Error('Unrecognised encrypted value.');
  }
  return JSON.parse(plain.toString('utf8'));
}

// True when a stored value already uses the current key.
const isCurrent = (text) => !text || String(text).startsWith(`v2:${currentKeyId()}:`);

// For tests only.
function resetForTests() { cached = undefined; previous = undefined; }

module.exports = { seal, open, sealBuffer, openBuffer, bufferKeyId, configured, requireKey, parseKey, keyId, currentKeyId, knownKeyIds, isCurrent, resetForTests };
