'use strict';
// Clinic core: encryption at rest, assignment-scoped access, signed notes, private documents,
// audit trail and deletion rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');
const vault = require('../src/vault');

let ctx;
let owner;
const users = {};

async function staffClient(name, email, role) {
  await owner.post('/admin/settings/staff', { name, email, password: 'password123', role }, '/admin/settings/staff');
  const c = new Client(ctx.base);
  const res = await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(res.location, '/admin', `login ${email}`);
  c.id = (await get('SELECT id FROM staff WHERE email = ?', email)).id;
  return c;
}

// Multipart POST with the session's CSRF token.
async function upload(client, url, fields, file, from) {
  const page = await client.get(from);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const form = new FormData();
  form.append('_csrf', csrf);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([file.body], { type: file.type }), file.name);
  const res = await fetch(ctx.base + url, {
    method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  return { status: res.status, location: res.headers.get('location') };
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  users.ann = await staffClient('Ann Herbalist', 'ann@example.com', 'practitioner');
  users.ben = await staffClient('Ben Herbalist', 'ben@example.com', 'practitioner');
  users.cara = await staffClient('Cara Manager', 'cara@example.com', 'clinic_manager');
  users.dev = await staffClient('Dev Admin', 'dev@example.com', 'administrator');
});
after(() => ctx.close());

test('vault encrypts, detects tampering and validates keys', () => {
  const sealed = vault.seal({ med: 'Lisinopril 10 mg' });
  assert.match(sealed, /^v2:[0-9a-f]{8}:/);
  assert.doesNotMatch(sealed, /Lisinopril/);
  assert.deepEqual(vault.open(sealed), { med: 'Lisinopril 10 mg' });
  assert.notEqual(vault.seal('same'), vault.seal('same'), 'random IV per value');
  const raw = Buffer.from(sealed.split(":")[2], "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => vault.open(`${sealed.split(":").slice(0, 2).join(":")}:${raw.toString("base64")}`));
  assert.throws(() => vault.parseKey('too-short'), /32 bytes/);
  const buf = Buffer.from('%PDF-1.4 lab result');
  assert.deepEqual(vault.openBuffer(vault.sealBuffer(buf)), buf);
});

test('a deployed site without a key keeps clinic records locked', () => {
  const saved = { key: process.env.CLINIC_ENCRYPTION_KEY, db: process.env.DATABASE_URL };
  try {
    delete process.env.CLINIC_ENCRYPTION_KEY;
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    vault.resetForTests();
    assert.equal(vault.configured(), false);
    assert.throws(() => vault.seal('x'), /locked/);
  } finally {
    process.env.CLINIC_ENCRYPTION_KEY = saved.key;
    if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db;
    vault.resetForTests();
  }
});

let patientId;

test('a practitioner creates a patient (consent required) and is assigned to it', async () => {
  let res = await users.ann.post('/admin/clinic/patients/new', { email: 'river@example.com', first_name: 'River', last_name: 'Stone' }, '/admin/clinic/patients/new');
  assert.match(res.location, /patients\/new/, 'no consent, no record');
  assert.equal(await get('SELECT 1 FROM patients'), undefined);
  res = await users.ann.post('/admin/clinic/patients/new', {
    email: 'river@example.com', first_name: 'River', last_name: 'Stone', consent: '1',
    date_of_birth: '1985-04-12', emergency_name: 'Sky Stone', summary: 'Seeking support with sleep',
  }, '/admin/clinic/patients/new');
  assert.match(res.location, /\/admin\/clinic\/patients\/\d+$/);
  patientId = Number(res.location.split('/').pop());
  const row = await get('SELECT * FROM patients WHERE id = ?', patientId);
  assert.doesNotMatch(row.profile_enc, /1985|Sky Stone|sleep/, 'profile is ciphertext in the database');
  assert.equal(vault.open(row.profile_enc).date_of_birth, '1985-04-12');
  assert.ok(await get('SELECT 1 FROM practitioner_assignments WHERE patient_id = ? AND staff_id = ? AND is_primary = 1', patientId, users.ann.id));
  assert.ok(await get("SELECT 1 FROM customers WHERE email = 'river@example.com'"), 'patient is linked to a customer');
  const page = await users.ann.get(`/admin/clinic/patients/${patientId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /River Stone/);
  assert.match(page.text, /1985-04-12/);
});

test('only assigned practitioners and clinic managers can see the record', async () => {
  for (const tab of ['overview', 'health', 'notes', 'documents', 'timeline']) {
    assert.equal((await users.ben.get(`/admin/clinic/patients/${patientId}?tab=${tab}`)).status, 404, `ben ${tab}`);
    assert.equal((await users.cara.get(`/admin/clinic/patients/${patientId}?tab=${tab}`)).status, 200, `cara ${tab}`);
  }
  assert.doesNotMatch((await users.ben.get('/admin/clinic/patients')).text, /River/);
  // Administrators manage the business but get no clinical access by default.
  assert.equal((await users.dev.get('/admin/clinic/patients')).status, 403);
  assert.equal((await users.dev.get(`/admin/clinic/patients/${patientId}`)).status, 403);
  assert.doesNotMatch((await users.dev.get('/admin')).text, /href="\/admin\/clinic\/patients"/);
  assert.match((await users.ann.get('/admin')).text, /href="\/admin\/clinic\/patients"/);
  // Writes are scoped the same way.
  await users.ben.post(`/admin/clinic/patients/${patientId}/health`, { category: 'allergy', name: 'Sneaky' }, '/admin');
  assert.equal(await get("SELECT 1 FROM patient_health_items WHERE patient_id = ? AND recorded_by = ?", patientId, users.ben.id), undefined);
  // A clinic manager assigns Ben, who can then see it.
  await users.cara.post(`/admin/clinic/patients/${patientId}/assignments`, { staff_id: users.ben.id }, `/admin/clinic/patients/${patientId}`);
  assert.equal((await users.ben.get(`/admin/clinic/patients/${patientId}`)).status, 200);
  await users.cara.post(`/admin/clinic/patients/${patientId}/assignments/${users.ben.id}/delete`, {}, `/admin/clinic/patients/${patientId}`);
  assert.equal((await users.ben.get(`/admin/clinic/patients/${patientId}`)).status, 404);
  // Practitioners can't assign.
  await users.ann.post(`/admin/clinic/patients/${patientId}/assignments`, { staff_id: users.ben.id }, `/admin/clinic/patients/${patientId}`);
  assert.equal(await get('SELECT 1 FROM practitioner_assignments WHERE patient_id = ? AND staff_id = ?', patientId, users.ben.id), undefined);
  // The owner role can't grant clinic access through an administrator.
  const admins = await get("SELECT id FROM roles WHERE key = 'administrator'");
  await users.dev.post(`/admin/settings/roles/${admins.id}`, { name: 'Administrator', permissions: ['clinic.patients.view_all', 'staff.manage'] }, '/admin/settings/roles');
  assert.equal(await get("SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_key = 'clinic.patients.view_all'", admins.id), undefined);
});

test('health history is encrypted and allergies are flagged on the record', async () => {
  const from = `/admin/clinic/patients/${patientId}?tab=health`;
  await users.ann.post(`/admin/clinic/patients/${patientId}/health`, { category: 'medication', name: 'Sertraline 50 mg', details: 'Daily, morning' }, from);
  await users.ann.post(`/admin/clinic/patients/${patientId}/health`, { category: 'allergy', name: 'Ragweed', details: 'Hay fever' }, from);
  const rows = await all('SELECT data_enc FROM patient_health_items WHERE patient_id = ?', patientId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !/Sertraline|Ragweed/.test(r.data_enc)));
  const page = await users.ann.get(`/admin/clinic/patients/${patientId}`);
  assert.match(page.text, /Allergies:<\/strong> Ragweed/);
  const tab = await users.ann.get(from);
  assert.match(tab.text, /Sertraline 50 mg/);
});

test('notes: drafts belong to their author, signing locks them, amendments link back', async () => {
  const from = `/admin/clinic/patients/${patientId}?tab=notes`;
  await users.ann.post(`/admin/clinic/patients/${patientId}/notes`, { kind: 'soap', subjective: 'Waking at 3am nightly', plan: 'Review in 4 weeks', sign: '0' }, from);
  const note = await get('SELECT * FROM clinical_notes WHERE patient_id = ? ORDER BY id DESC LIMIT 1', patientId);
  assert.equal(note.signed_at, null);
  assert.doesNotMatch(note.body_enc, /3am/);
  // Another staff member who can see the patient can't edit or sign Ann's draft.
  await users.cara.post(`/admin/clinic/patients/${patientId}/notes/${note.id}`, { subjective: 'changed', sign: '1' }, from);
  assert.equal((await get('SELECT signed_at FROM clinical_notes WHERE id = ?', note.id)).signed_at, null);
  await users.ann.post(`/admin/clinic/patients/${patientId}/notes/${note.id}`, { subjective: 'Waking at 3am most nights', plan: 'Review in 4 weeks', sign: '1' }, from);
  const signed = await get('SELECT * FROM clinical_notes WHERE id = ?', note.id);
  assert.ok(signed.signed_at);
  assert.equal(vault.open(signed.body_enc).subjective, 'Waking at 3am most nights');
  // Locked in the application...
  await users.ann.post(`/admin/clinic/patients/${patientId}/notes/${note.id}`, { subjective: 'rewrite history', sign: '0' }, from);
  assert.equal(vault.open((await get('SELECT body_enc FROM clinical_notes WHERE id = ?', note.id)).body_enc).subjective, 'Waking at 3am most nights');
  await users.ann.post(`/admin/clinic/patients/${patientId}/notes/${note.id}/delete`, {}, from);
  assert.ok(await get('SELECT 1 FROM clinical_notes WHERE id = ?', note.id));
  // ...and in the database itself.
  await assert.rejects(run("UPDATE clinical_notes SET kind = 'internal' WHERE id = ?", note.id), /signed clinical notes/);
  await assert.rejects(run('DELETE FROM clinical_notes WHERE id = ?', note.id), /signed clinical notes/);
  await users.ann.post(`/admin/clinic/patients/${patientId}/notes`, { kind: 'consultation', text: 'Correction: wakes at 4am', amends_note_id: note.id, sign: '1' }, from);
  const amendment = await get('SELECT * FROM clinical_notes WHERE amends_note_id = ?', note.id);
  assert.ok(amendment && amendment.signed_at);
  const page = await users.ann.get(from);
  assert.match(page.text, /Waking at 3am most nights/);
  assert.match(page.text, /Correction: wakes at 4am/);
  assert.match(page.text, /SOAP note · \d{4}-\d{2}-\d{2}/, 'visit dates display as YYYY-MM-DD');
});

test('documents are encrypted in private storage and only served to permitted staff', async () => {
  const body = Buffer.from('%PDF-1.4\nCBC: haemoglobin 13.5 g/dL\n');
  const res = await upload(users.ann, `/admin/clinic/patients/${patientId}/documents`, { kind: 'lab_result', title: 'Blood panel' },
    { body, type: 'application/pdf', name: 'labs.pdf' }, `/admin/clinic/patients/${patientId}?tab=documents`);
  assert.equal(res.status, 302);
  const doc = await get('SELECT * FROM patient_documents WHERE patient_id = ?', patientId);
  assert.ok(doc);
  const onDisk = fs.readFileSync(path.join(process.env.PRIVATE_UPLOAD_DIR, doc.storage_key));
  assert.ok(!onDisk.includes(Buffer.from('haemoglobin')), 'file is encrypted at rest');
  assert.doesNotMatch(doc.title_enc, /Blood panel/);
  const download = await fetch(`${ctx.base}/admin/clinic/patients/${patientId}/documents/${doc.id}`, {
    headers: { cookie: [...users.ann.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
  assert.equal((await users.ben.get(`/admin/clinic/patients/${patientId}/documents/${doc.id}`)).status, 404);
  assert.equal((await new Client(ctx.base).get(`/admin/clinic/patients/${patientId}/documents/${doc.id}`)).status, 302, 'signed-out visitors are sent to log in');
  // Uploaded files are never reachable under the public /uploads path.
  assert.notEqual((await new Client(ctx.base).get(`/uploads/${doc.storage_key}`)).status, 200);
  const bad = await upload(users.ann, `/admin/clinic/patients/${patientId}/documents`, {}, { body: Buffer.from('<script>'), type: 'text/html', name: 'x.html' }, `/admin/clinic/patients/${patientId}?tab=documents`);
  assert.equal(bad.status, 302);
  assert.equal((await all('SELECT id FROM patient_documents WHERE patient_id = ?', patientId)).length, 1, 'disallowed file types are rejected');
});

test('every view and change is audited, without clinical content', async () => {
  const actions = (await all("SELECT DISTINCT action FROM audit_logs WHERE entity_type = 'patient'")).map((r) => r.action);
  for (const a of ['patient.created', 'patient.viewed', 'patient.health_added', 'patient.note_created', 'patient.note_signed', 'patient.document_uploaded', 'patient.document_viewed', 'patient.assigned', 'patient.access_refused']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  const all_ = await all('SELECT details FROM audit_logs');
  for (const secret of ['Sertraline', 'Ragweed', '3am', 'haemoglobin', '1985-04-12', 'Blood panel']) {
    assert.ok(all_.every((r) => !r.details.includes(secret)), `audit log leaked "${secret}"`);
  }
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'patient.access_refused' AND actor_name = 'Ben Herbalist'"));
});

test('timeline lists record events; customers with clinic records cannot be casually deleted', async () => {
  const page = await users.ann.get(`/admin/clinic/patients/${patientId}?tab=timeline`);
  assert.match(page.text, /Patient record created/);
  assert.match(page.text, /SOAP note/);
  assert.match(page.text, /Lab result uploaded/);
  const p = await get('SELECT customer_id FROM patients WHERE id = ?', patientId);
  await owner.post(`/admin/customers/${p.customer_id}/delete`, {}, `/admin/customers/${p.customer_id}`);
  assert.ok(await get('SELECT 1 FROM customers WHERE id = ?', p.customer_id));
});

test('only an owner can permanently delete a record, and it removes notes and files', async () => {
  const doc = await get('SELECT storage_key FROM patient_documents WHERE patient_id = ?', patientId);
  await users.cara.post(`/admin/clinic/patients/${patientId}/delete`, { confirm: 'river@example.com' }, `/admin/clinic/patients/${patientId}`);
  assert.ok(await get('SELECT 1 FROM patients WHERE id = ?', patientId));
  await owner.post(`/admin/clinic/patients/${patientId}/delete`, { confirm: 'wrong@example.com' }, `/admin/clinic/patients/${patientId}`);
  assert.ok(await get('SELECT 1 FROM patients WHERE id = ?', patientId));
  await owner.post(`/admin/clinic/patients/${patientId}/delete`, { confirm: 'river@example.com' }, `/admin/clinic/patients/${patientId}`);
  assert.equal(await get('SELECT 1 FROM patients WHERE id = ?', patientId), undefined);
  assert.equal(await get('SELECT 1 FROM clinical_notes WHERE patient_id = ?', patientId), undefined, 'signed notes go with the record');
  assert.equal(fs.existsSync(path.join(process.env.PRIVATE_UPLOAD_DIR, doc.storage_key)), false);
  assert.ok(await get("SELECT 1 FROM customers WHERE email = 'river@example.com'"), 'the customer account stays');
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'patient.deleted'"));
});
