'use strict';
// Two-step sign-in for staff: time-based one-time codes (RFC 6238 — Google Authenticator, 1Password,
// Authy, Microsoft Authenticator...) plus single-use recovery codes. Secrets are encrypted with the
// site encryption key (CLINIC_ENCRYPTION_KEY), so the database never holds them in readable form.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { get, all, run, tx } = require('./db');
const vault = require('./vault');
const settings = require('./settings');

const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const codeAt = (secret, ms) => hotp(secret, stepAt(ms));

// Returns the matched time step (allowing one step of clock drift either way), or null.
function verifyCode(secret, code, ms = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(ms);
  for (const step of [now, now - 1, now + 1]) {
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

function otpauthUrl(secret, account) {
  const issuer = settings.load('store').name || 'Store admin';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=${STEP}&digits=6&algorithm=SHA1`;
}

async function isEnabled(staffId) {
  return Boolean(await get('SELECT 1 FROM staff WHERE id = ? AND totp_enabled_at IS NOT NULL', staffId));
}

// Checks a code (or a recovery code) for a staff member with two-step sign-in on. A code can't be used twice.
async function check(staffId, code) {
  const s = await get('SELECT totp_secret_enc, totp_last_step FROM staff WHERE id = ? AND totp_enabled_at IS NOT NULL', staffId);
  if (!s) return { ok: false };
  const input = String(code || '').trim();
  if (/^\d[\d\s]{5,6}$/.test(input)) {
    const step = verifyCode(vault.open(s.totp_secret_enc), input);
    if (step === null || (s.totp_last_step !== null && step <= Number(s.totp_last_step))) return { ok: false };
    const claimed = await run('UPDATE staff SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, staffId, step);
    return { ok: Boolean(claimed.changes) };
  }
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length !== 10) return { ok: false };
  for (const r of await all('SELECT id, code_hash FROM staff_recovery_codes WHERE staff_id = ? AND used_at IS NULL', staffId)) {
    if (bcrypt.compareSync(normalized, r.code_hash)) {
      const used = await run('UPDATE staff_recovery_codes SET used_at = now() WHERE id = ? AND used_at IS NULL', r.id);
      return { ok: Boolean(used.changes), recovery: true };
    }
  }
  return { ok: false };
}

function makeRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// Turns two-step sign-in on after the person proves their app works. Returns the recovery codes.
async function enable(staffId, secret, code) {
  const step = verifyCode(secret, code);
  if (step === null) return null;
  const codes = makeRecoveryCodes();
  await tx(async () => {
    await run('UPDATE staff SET totp_secret_enc = ?, totp_enabled_at = now(), totp_last_step = ? WHERE id = ?', vault.seal(secret), step, staffId);
    await run('DELETE FROM staff_recovery_codes WHERE staff_id = ?', staffId);
    for (const c of codes) await run('INSERT INTO staff_recovery_codes (staff_id, code_hash) VALUES (?, ?)', staffId, bcrypt.hashSync(c.replace('-', ''), 8));
  });
  return codes;
}

async function newRecoveryCodes(staffId) {
  const codes = makeRecoveryCodes();
  await tx(async () => {
    await run('DELETE FROM staff_recovery_codes WHERE staff_id = ?', staffId);
    for (const c of codes) await run('INSERT INTO staff_recovery_codes (staff_id, code_hash) VALUES (?, ?)', staffId, bcrypt.hashSync(c.replace('-', ''), 8));
  });
  return codes;
}

async function disable(staffId) {
  await tx(async () => {
    await run('UPDATE staff SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?', staffId);
    await run('DELETE FROM staff_recovery_codes WHERE staff_id = ?', staffId);
  });
}

const remainingCodes = async (staffId) => Number((await get('SELECT COUNT(*) AS n FROM staff_recovery_codes WHERE staff_id = ? AND used_at IS NULL', staffId)).n);

// Whether this staff member must turn two-step sign-in on before using the admin.
function required(staff) {
  if (!vault.configured()) return false; // can't be set up without the site key, so never lock anyone out
  const rule = settings.load('security').require_two_factor;
  if (rule === 'all') return true;
  if (rule === 'clinical') return [...staff.permissions].some((p) => p.startsWith('clinic.')) || staff.role === 'owner';
  return false;
}

module.exports = { newSecret, base32Encode, base32Decode, hotp, codeAt, verifyCode, otpauthUrl, isEnabled, check, enable, disable, newRecoveryCodes, remainingCodes, required };
