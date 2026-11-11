'use strict';
// Two-step sign-in for staff, and rotating the clinic encryption key.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, Client } = require('./helpers');
const { get, all, run, insert } = require('../src/db');
const twofactor = require('../src/twofactor');
const vault = require('../src/vault');
const settings = require('../src/settings');
const storage = require('../src/storage');
const keyrotation = require('../src/keyrotation');

let ctx;
let owner;
const ids = {};

async function login(email, password = 'password123') {
  const c = new Client(ctx.base);
  const res = await c.post('/admin/login', { email, password, next: '/admin' }, '/admin/login');
  return { c, res };
}

before(async () => {
  ctx = await start();
  owner = (await login('owner@example.com')).c;
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  await owner.post('/admin/settings/staff', { name: 'Cass Service', email: 'cass@example.com', password: 'password123', role: 'customer_service' }, '/admin/settings/staff');
  ids.ann = (await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id;
});
after(() => ctx.close());

test('one-time codes match the RFC 6238 test vector and allow one step of clock drift', () => {
  const secret = twofactor.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(twofactor.codeAt(secret, 59000), '287082');
  assert.equal(twofactor.codeAt(secret, 1111111109000), '081804');
  assert.notEqual(twofactor.verifyCode(secret, '287082', 59000 + 30000), null, 'previous step accepted');
  assert.equal(twofactor.verifyCode(secret, '287082', 59000 + 90000), null, 'older codes refused');
  assert.equal(twofactor.verifyCode(secret, 'abcdef', 59000), null);
});

test('a staff member turns on two-step sign-in, then needs a code (or a recovery code) to sign in', async () => {
  const { c: ann } = await login('ann@example.com');
  let page = await ann.get('/admin/profile/two-factor');
  assert.match(page.text, /<svg/, 'QR code shown');
  const secret = page.text.match(/<code class="mono">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
  let res = await ann.post('/admin/profile/two-factor/enable', { code: '000000' }, '/admin/profile');
  assert.equal(res.location, '/admin/profile/two-factor', 'wrong code refused');
  // The page made a new secret on that visit; read it again.
  page = await ann.get('/admin/profile/two-factor');
  const secret2 = page.text.match(/<code class="mono">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
  assert.notEqual(secret2, secret);
  res = await ann.post('/admin/profile/two-factor/enable', { code: twofactor.codeAt(secret2) }, '/admin/profile');
  const codes = [...res.text.matchAll(/<li>([a-z0-9]{5}-[a-z0-9]{5})<\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  const row = await get('SELECT totp_secret_enc, totp_enabled_at FROM staff WHERE id = ?', ids.ann);
  assert.ok(row.totp_enabled_at);
  assert.doesNotMatch(row.totp_secret_enc, new RegExp(secret2), 'secret stored encrypted');
  assert.equal((await get('SELECT COUNT(*) AS n FROM staff_recovery_codes WHERE staff_id = ?', ids.ann)).n, 10);

  // Password alone no longer signs in.
  const { c, res: first } = await login('ann@example.com');
  assert.equal(first.location, '/admin/login/verify');
  assert.equal((await c.get('/admin')).status, 302, 'not signed in yet');
  let v = await c.post('/admin/login/verify', { code: '123456' }, '/admin/login/verify');
  assert.equal(v.location, '/admin/login/verify');
  v = await c.post('/admin/login/verify', { code: twofactor.codeAt(secret2, Date.now() + 30000) }, '/admin/login/verify');
  assert.equal(v.location, '/admin');
  assert.equal((await c.get('/admin')).status, 200);
  // The same code can't be used twice.
  const { c: again } = await login('ann@example.com');
  v = await again.post('/admin/login/verify', { code: twofactor.codeAt(secret2, Date.now() + 30000) }, '/admin/login/verify');
  assert.equal(v.location, '/admin/login/verify');
  // A recovery code works once.
  v = await again.post('/admin/login/verify', { code: codes[0].toUpperCase() }, '/admin/login/verify');
  assert.equal(v.location, '/admin');
  const { c: third } = await login('ann@example.com');
  v = await third.post('/admin/login/verify', { code: codes[0] }, '/admin/login/verify');
  assert.equal(v.location, '/admin/login/verify');
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'staff.two_factor_failed'"));
  ids.annSecret = secret2;
});

test('too many wrong codes end the sign-in attempt', async () => {
  await run('DELETE FROM login_attempts');
  const { c } = await login('ann@example.com');
  for (let i = 0; i < 5; i++) await c.post('/admin/login/verify', { code: '111111' }, '/admin/login/verify');
  let v = await c.post('/admin/login/verify', { code: twofactor.codeAt(ids.annSecret, Date.now() + 30000) }, '/admin/login');
  assert.equal(v.location, '/admin/login');
  assert.equal((await c.get('/admin')).status, 302);
  // And the per-address limit also applies to code guesses.
  for (let i = 0; i < 12; i++) v = await c.post('/admin/login/verify', { code: '111111' }, '/admin/login');
  assert.equal(v.status, 429);
  await run('DELETE FROM login_attempts');
});

test('the owner can require two-step sign-in for clinical roles, and reset it for someone who lost their phone', async () => {
  await owner.post('/admin/settings/security', { require_two_factor: 'clinical' }, '/admin/settings/security');
  assert.equal(settings.load('security').require_two_factor, 'clinical');
  // The owner hasn't set it up, so is sent to set it up; Cass (no clinical access) isn't.
  assert.equal((await owner.get('/admin/orders')).location, '/admin/profile/two-factor');
  const { c: cass } = await login('cass@example.com');
  assert.equal((await cass.get('/admin/orders')).status, 200);
  // Owner sets it up.
  const page = await owner.get('/admin/profile/two-factor');
  const secret = page.text.match(/<code class="mono">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
  await owner.post('/admin/profile/two-factor/enable', { code: twofactor.codeAt(secret) }, '/admin/profile');
  assert.equal((await owner.get('/admin/orders')).status, 200);
  // Required, so it can't be switched off.
  const off = await owner.post('/admin/profile/two-factor/disable', { password: 'password123', code: twofactor.codeAt(secret, Date.now() + 30000) }, '/admin/profile');
  assert.equal(off.location, '/admin/profile/two-factor');
  assert.ok(await twofactor.isEnabled((await get("SELECT id FROM staff WHERE email = 'owner@example.com'")).id));
  // Reset Ann: her sessions end and she must set it up again.
  await owner.post(`/admin/settings/staff/${ids.ann}/reset-two-factor`, {}, '/admin/settings/staff');
  assert.equal(await twofactor.isEnabled(ids.ann), false);
  assert.equal((await get('SELECT COUNT(*) AS n FROM staff_recovery_codes WHERE staff_id = ?', ids.ann)).n, 0);
  const { c: ann, res } = await login('ann@example.com');
  assert.equal(res.location, '/admin');
  assert.equal((await ann.get('/admin/clinic/patients')).location, '/admin/profile/two-factor');
  // Cass can't reset anyone (no staff.manage).
  assert.equal((await cass.post(`/admin/settings/staff/${ids.ann}/reset-two-factor`, {}, '/admin/orders')).status, 403);
  await settings.save('security', { require_two_factor: 'none' });
});

/* ---------- Key rotation ---------- */

function legacyFile(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

test('rotating the key re-encrypts every value and file, signed notes included, without changing them', async () => {
  const oldKeyHex = process.env.CLINIC_ENCRYPTION_KEY;
  const customer = await insert("INSERT INTO customers (email, first_name, last_name) VALUES ('kim@example.com', 'Kim', 'Ash')");
  const patient = await insert('INSERT INTO patients (customer_id, profile_enc, consent_at) VALUES (?, ?, now())', customer, vault.seal({ summary: 'Old-key profile' }));
  await insert('INSERT INTO patient_health_items (patient_id, category, data_enc) VALUES (?, ?, ?)', patient, 'allergy', vault.seal({ title: 'Birch pollen' }));
  // A value from before key ids existed ("v1:").
  const legacyValue = `v1:${legacyFile(Buffer.from(oldKeyHex, 'hex'), Buffer.from(JSON.stringify({ title: 'Legacy item' }))).toString('base64')}`;
  await insert('INSERT INTO patient_health_items (patient_id, category, data_enc) VALUES (?, ?, ?)', patient, 'history', legacyValue);
  const note = await insert("INSERT INTO clinical_notes (patient_id, kind, body_enc, visit_date, author_id, author_name, signed_at) VALUES (?, 'internal', ?, CURRENT_DATE, NULL, 'Owner', now())", patient, vault.seal({ text: 'Signed under the old key' }));
  await storage.savePrivate('patients/rot/a', vault.sealBuffer(Buffer.from('file A')));
  await storage.savePrivate('patients/rot/b', legacyFile(Buffer.from(oldKeyHex, 'hex'), Buffer.from('legacy file B')));
  for (const k of ['a', 'b']) await insert("INSERT INTO patient_documents (patient_id, kind, title_enc, storage_key, mime, size_bytes) VALUES (?, 'document', ?, ?, 'text/plain', 6)", patient, vault.seal(`Doc ${k}`), `patients/rot/${k}`);

  // Rotate: new key current, old key kept for reading.
  const newKeyHex = crypto.randomBytes(32).toString('hex');
  process.env.CLINIC_ENCRYPTION_KEY = newKeyHex;
  process.env.CLINIC_ENCRYPTION_KEY_PREVIOUS = oldKeyHex;
  vault.resetForTests();
  try {
    const before = await keyrotation.status();
    assert.ok(before.oldValues >= 6, `old values counted (${before.oldValues})`);
    assert.equal(before.files.old, 2);
    assert.equal(before.done, false);
    assert.deepEqual(vault.open(legacyValue), { title: 'Legacy item' }, 'still readable with the previous key');
    const page = await owner.get('/admin/settings/security');
    assert.match(page.text, /still on an older key/);
    // Run batches through the screen until done.
    for (let i = 0; i < 10 && !(await keyrotation.status()).done; i++) await owner.post('/admin/settings/security/reencrypt', {}, '/admin/settings/security');
    const after_ = await keyrotation.status();
    assert.equal(after_.done, true, JSON.stringify(after_));
    assert.match((await get('SELECT body_enc FROM clinical_notes WHERE id = ?', note)).body_enc, new RegExp(`^v2:${vault.keyId(Buffer.from(newKeyHex, 'hex'))}:`));
    // Signed notes are still locked against normal edits.
    await assert.rejects(run('UPDATE clinical_notes SET body_enc = ? WHERE id = ?', vault.seal({ text: 'tampered' }), note), /cannot be changed/);
    await assert.rejects(run("UPDATE clinical_notes SET kind = 'soap' WHERE id = ?", note), /cannot be changed/);

    // Drop the old key: everything still opens.
    delete process.env.CLINIC_ENCRYPTION_KEY_PREVIOUS;
    vault.resetForTests();
    assert.deepEqual(vault.open((await get('SELECT body_enc FROM clinical_notes WHERE id = ?', note)).body_enc), { text: 'Signed under the old key' });
    const items = (await all('SELECT data_enc FROM patient_health_items WHERE patient_id = ? ORDER BY id', patient)).map((r) => vault.open(r.data_enc).title);
    assert.deepEqual(items, ['Birch pollen', 'Legacy item']);
    assert.equal(vault.openBuffer(await storage.readPrivate('patients/rot/a')).toString(), 'file A');
    assert.equal(vault.openBuffer(await storage.readPrivate('patients/rot/b')).toString(), 'legacy file B');
    assert.equal(vault.open((await get('SELECT profile_enc FROM patients WHERE id = ?', patient)).profile_enc).summary, 'Old-key profile');
    // Only owners can run it.
    assert.equal((await (await login('cass@example.com')).c.post('/admin/settings/security/reencrypt', {}, '/admin/orders')).status, 403);
  } finally {
    process.env.CLINIC_ENCRYPTION_KEY = oldKeyHex;
    delete process.env.CLINIC_ENCRYPTION_KEY_PREVIOUS;
    vault.resetForTests();
  }
});

test('staff who can see patient records are signed out when idle; others are not', async () => {
  await settings.save('security', { clinical_idle_minutes: 30 });
  const { c: cass } = await login('cass@example.com');
  assert.equal((await cass.get('/admin/orders')).status, 200);
  // Age every session's last activity by an hour.
  for (const row of await all('SELECT sid, data FROM sessions')) {
    const data = JSON.parse(row.data);
    if (data.lastActive) { data.lastActive -= 3600000; await run('UPDATE sessions SET data = ? WHERE sid = ?', JSON.stringify(data), row.sid); }
  }
  assert.equal((await cass.get('/admin/orders')).status, 200, 'no clinical access: no idle limit');
  const res = await owner.get('/admin/orders');
  assert.match(res.location, /^\/admin\/login\?next=/);
  assert.equal((await owner.get('/admin')).status, 302, 'signed out');
});
