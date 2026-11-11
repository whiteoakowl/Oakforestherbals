'use strict';
// Leads pipeline, drip-fed programs and the food journal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, run, insert } = require('../src/db');
const vault = require('../src/vault');

let ctx;
let owner;
let ann;
let patientClient;
const ids = {};

async function login(email) {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  return c;
}

before(async () => {
  ctx = await start();
  owner = await login('owner@example.com');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  await owner.post('/admin/settings/staff', { name: 'Ivo Stock', email: 'ivo@example.com', password: 'password123', role: 'inventory_manager' }, '/admin/settings/staff');
  ann = await login('ann@example.com');
});
after(() => ctx.close());

/* ---------- Leads ---------- */

test('a contact form enquiry becomes a lead; repeat enquiries add to it instead of duplicating', async () => {
  const visitor = new Client(ctx.base);
  await visitor.post('/contact', { name: 'Mara Lin', email: 'Mara@Example.com', message: 'Do you help with eczema?' }, '/pages/contact');
  await visitor.post('/contact', { name: 'Mara Lin', email: 'mara@example.com', message: 'Also: do you have evening hours?' }, '/pages/contact');
  const leads = await get("SELECT COUNT(*) AS n FROM leads WHERE email = 'mara@example.com'");
  assert.equal(leads.n, 1);
  const lead = await get("SELECT * FROM leads WHERE email = 'mara@example.com'");
  assert.equal(lead.stage, 'new');
  assert.equal(lead.source, 'Contact form');
  assert.match(lead.notes, /evening hours/);
  assert.ok(await get("SELECT 1 FROM notifications WHERE kind = 'lead'"));
  ids.lead = lead.id;
  const board = await ann.get('/admin/leads');
  assert.match(board.text, /Mara Lin/);
  assert.match(board.text, /New enquiry/);
  // Roles without leads can't see them.
  const ivo = await login('ivo@example.com');
  assert.equal((await ivo.get('/admin/leads')).status, 403);
});

test('leads move through stages with notes and follow-ups; overdue follow-ups notify the owner', async () => {
  await ann.post(`/admin/leads/${ids.lead}`, { stage: 'contacted', add_note: 'Called, sending info pack', next_follow_up: '2020-01-01', owner_id: String((await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id) }, `/admin/leads/${ids.lead}`);
  const lead = await get('SELECT * FROM leads WHERE id = ?', ids.lead);
  assert.equal(lead.stage, 'contacted');
  assert.match(lead.notes, /\[\d{4}-\d{2}-\d{2}, Ann Herbalist\] Called, sending info pack/);
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'lead.stage_changed'"));
  const board = await ann.get('/admin/leads');
  assert.match(board.text, /critical-text">Follow up/);
  // Daily digest reminds the owner.
  const settings = require('../src/settings');
  await settings.save('automation', { last_digest_day: '' });
  await require('../src/automation').dailyDigest(new Date());
  assert.ok(await get("SELECT 1 FROM notifications WHERE title = 'Follow up with Mara Lin today' AND staff_id IS NOT NULL"));
  // Added by hand from the board.
  const res = await ann.post('/admin/leads', { name: 'Theo Park', email: 'theo@example.com', source: 'Event or workshop', interest: 'Met at the herb walk' }, '/admin/leads');
  assert.match(res.location, /^\/admin\/leads\/\d+$/);
});

test('converting a lead makes a customer and can continue into a clinic record', async () => {
  const res = await ann.post(`/admin/leads/${ids.lead}/convert`, { clinic: '1' }, `/admin/leads/${ids.lead}`);
  assert.equal(res.location, '/admin/clinic/patients/new?email=mara%40example.com');
  const lead = await get('SELECT * FROM leads WHERE id = ?', ids.lead);
  assert.equal(lead.stage, 'client');
  const customer = await get('SELECT * FROM customers WHERE id = ?', lead.customer_id);
  assert.equal(customer.first_name, 'Mara');
  assert.equal(customer.last_name, 'Lin');
  assert.match((await ann.get(res.location)).text, /mara@example.com/);
});

/* ---------- Programs and the food journal ---------- */

test('course lessons open on their scheduled day, and locked lessons can’t be opened early', async () => {
  const r = await ann.post('/admin/clinic/patients/new', { email: 'sol@example.com', first_name: 'Sol', last_name: 'Day', consent: '1' }, '/admin/clinic/patients/new');
  ids.patient = Number(r.location.split('/').pop());
  const l1 = await insert("INSERT INTO lessons (title, kind, status, body_html) VALUES ('Week 1: Sleep basics', 'lesson', 'published', '<p>One</p>')");
  const l2 = await insert("INSERT INTO lessons (title, kind, status, body_html) VALUES ('Week 2: Wind-down routine', 'lesson', 'published', '<p>Two</p>')");
  const course = await insert("INSERT INTO courses (title, status) VALUES ('Sleep program', 'published')");
  await run('INSERT INTO course_lessons (course_id, lesson_id, position) VALUES (?, ?, 0), (?, ?, 1)', course, l1, course, l2);
  await owner.post(`/admin/education/courses/${course}`, { title: 'Sleep program', status: 'published', [`release_day[id${l2}]`]: '7' }, `/admin/education/courses/${course}`);
  assert.equal((await get('SELECT release_day FROM course_lessons WHERE course_id = ? AND lesson_id = ?', course, l2)).release_day, 7);
  await ann.post(`/admin/clinic/patients/${ids.patient}/learning`, { course_id: String(course) }, `/admin/clinic/patients/${ids.patient}?tab=learning`);
  // Give Sol a portal password.
  const bcrypt = require('bcryptjs');
  await run("UPDATE customers SET password_hash = ? WHERE email = 'sol@example.com'", bcrypt.hashSync('password123', 4));
  patientClient = new Client(ctx.base);
  await patientClient.post('/account/login', { email: 'sol@example.com', password: 'password123' }, '/account/login');
  let page = await patientClient.get('/account/clinic/learning');
  assert.match(page.text, /href="\/account\/clinic\/learning\/\d+"><strong>Week 1: Sleep basics/);
  assert.match(page.text, /Week 2: Wind-down routine<\/strong>.*\n.*Opens /);
  assert.equal((await patientClient.get(`/account/clinic/learning/${l2}`)).status, 404, 'not yet');
  assert.equal((await patientClient.get(`/account/clinic/learning/${l1}`)).status, 200);
  // A week later it opens.
  await run("UPDATE lesson_assignments SET assigned_at = now() - interval '8 days' WHERE patient_id = ?", ids.patient);
  assert.equal((await patientClient.get(`/account/clinic/learning/${l2}`)).status, 200);
});

test('clients log food and drink with an optional photo their practitioner can see', async () => {
  const page = await patientClient.get('/account/clinic/journal');
  const form = new FormData();
  form.append('_csrf', page.text.match(/name="_csrf" value="([^"]+)"/)[1]);
  form.append('kind', 'food');
  form.append('meal', 'lunch');
  form.append('food', 'Lentil soup and rye bread');
  form.append('after', 'a little bloated');
  form.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), 'lunch.jpg');
  const res = await fetch(`${ctx.base}/account/clinic/journal`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: [...patientClient.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 302);
  const log = await get("SELECT * FROM patient_logs WHERE patient_id = ? AND kind = 'food'", ids.patient);
  const data = vault.open(log.data_enc);
  assert.equal(data.meal, 'lunch');
  assert.ok(data.photo_doc_id);
  assert.doesNotMatch(log.data_enc, /Lentil/);
  const doc = await get('SELECT * FROM patient_documents WHERE id = ?', data.photo_doc_id);
  assert.equal(doc.kind, 'photo');
  assert.equal(doc.uploaded_by_patient, 1);
  const mine = await patientClient.get('/account/clinic/journal');
  assert.match(mine.text, /lunch: Lentil soup and rye bread — felt a little bloated/);
  const staffView = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=progress`);
  assert.match(staffView.text, /Lentil soup/);
  assert.match(staffView.text, new RegExp(`/documents/${data.photo_doc_id}`));
  const photo = await ann.get(`/admin/clinic/patients/${ids.patient}/documents/${data.photo_doc_id}`);
  assert.equal(photo.status, 200);
});
