'use strict';
// The patient workflow from the brief: a patient registers, completes an intake form; a
// practitioner reviews it, builds a care plan with an approved preparation, a product and a lesson;
// the patient uses their portal (tasks, lesson + quiz, journal, message, product to cart, upload);
// the practitioner reviews progress. Also checks what a patient can and cannot see.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');
const vault = require('../src/vault');

let ctx;
let owner;
let ann;
let patient;
let other;
const ids = {};

async function login(email) {
  const c = new Client(ctx.base);
  const res = await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(res.location, '/admin');
  return c;
}

async function upload(client, url, fields, file, from) {
  const page = await client.get(from);
  const form = new FormData();
  form.append('_csrf', page.text.match(/name="_csrf" value="([^"]+)"/)[1]);
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) form.append(k, x);
  if (file) form.append(file.field, new Blob([file.body], { type: file.type }), file.name);
  const res = await fetch(ctx.base + url, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  return { status: res.status, location: res.headers.get('location') };
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  ann = await login('ann@example.com');
});
after(() => ctx.close());

test('1-2. a new patient registers and completes an intake form (with a file and a conditional question)', async () => {
  patient = new Client(ctx.base);
  await patient.post('/account/register', { first_name: 'Robin', last_name: 'Fern', email: 'robin@example.com', password: 'password123' }, '/account/register');
  assert.equal((await patient.get('/account/clinic')).status, 404, 'no clinic record yet');
  let res = await ann.post('/admin/clinic/patients/new', { email: 'robin@example.com', consent: '1' }, '/admin/clinic/patients/new');
  ids.patient = Number(res.location.split('/').pop());
  // Build and publish an intake form with a conditional question.
  res = await ann.post('/admin/clinic/forms/new', {
    name: 'New patient intake', kind: 'intake',
    'fields[0][type]': 'textarea', 'fields[0][label]': 'What would you like help with?', 'fields[0][required]': '1',
    'fields[1][type]': 'choice', 'fields[1][label]': 'Do you take medication?', 'fields[1][options]': 'Yes\nNo', 'fields[1][required]': '1',
    'fields[2][type]': 'textarea', 'fields[2][label]': 'Which medications?', 'fields[2][required]': '1', 'fields[2][cond_field]': 'do_you_take_medication_1', 'fields[2][cond_value]': 'Yes',
    'fields[3][type]': 'file', 'fields[3][label]': 'Recent lab results',
    'fields[4][type]': 'signature', 'fields[4][label]': 'Signature', 'fields[4][required]': '1',
  }, '/admin/clinic/forms/new');
  ids.form = Number(res.location.split('/').pop());
  const form = await get('SELECT * FROM intake_forms WHERE id = ?', ids.form);
  const fields = JSON.parse(form.fields);
  assert.equal(fields.length, 5);
  assert.deepEqual(fields[2].condition, { field: fields[1].id, equals: 'Yes' });
  await ann.post(`/admin/clinic/forms/${ids.form}`, { name: form.name, kind: 'intake', status: 'published', ...Object.fromEntries(fields.flatMap((f, i) => [[`fields[${i}][id]`, f.id], [`fields[${i}][type]`, f.type], [`fields[${i}][label]`, f.label], [`fields[${i}][options]`, (f.options || []).join('\n')], [`fields[${i}][required]`, f.required ? '1' : ''], [`fields[${i}][cond_field]`, f.condition ? f.condition.field : ''], [`fields[${i}][cond_value]`, f.condition ? f.condition.equals : '']])) }, `/admin/clinic/forms/${ids.form}`);
  assert.equal((await get('SELECT status FROM intake_forms WHERE id = ?', ids.form)).status, 'published');
  await ann.post(`/admin/clinic/patients/${ids.patient}/forms`, { form_id: ids.form }, `/admin/clinic/patients/${ids.patient}?tab=forms`);
  const assignment = await get('SELECT * FROM form_assignments WHERE patient_id = ?', ids.patient);
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'robin@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.html, /Sign in to your account/);
  // The portal now exists; the account shows a My clinic link.
  assert.match((await patient.get('/account')).text, /My clinic/);
  assert.match((await patient.get('/account/clinic')).text, /New patient intake/);
  const formUrl = `/account/clinic/forms/${assignment.id}`;
  // Missing the conditional answer when "Yes" is chosen is rejected; nothing is stored.
  res = await upload(patient, formUrl, { f_what_would_you_like_help_with_0: 'Poor sleep for months', [`f_${fields[1].id}`]: 'Yes', [`f_${fields[4].id}`]: 'Robin Fern' }, null, formUrl);
  assert.equal(res.location, formUrl);
  assert.equal((await get('SELECT COUNT(*) AS n FROM form_submissions')).n, 0);
  res = await upload(patient, formUrl, { [`f_${fields[0].id}`]: 'Poor sleep for months', [`f_${fields[1].id}`]: 'Yes', [`f_${fields[2].id}`]: 'Example med 10 mg', [`f_${fields[4].id}`]: 'Robin Fern' },
    { field: `f_${fields[3].id}`, body: Buffer.from('%PDF-1.4 demo labs'), type: 'application/pdf', name: 'labs.pdf' }, formUrl);
  assert.equal(res.location, '/account/clinic');
  const sub = await get('SELECT * FROM form_submissions WHERE patient_id = ?', ids.patient);
  assert.doesNotMatch(sub.answers_enc, /Poor sleep|Example med/, 'answers are encrypted');
  const answers = vault.open(sub.answers_enc);
  assert.equal(answers[fields[2].id], 'Example med 10 mg');
  assert.ok(await get('SELECT 1 FROM patient_documents WHERE id = ? AND patient_id = ? AND uploaded_by_patient = 1', answers[fields[3].id], ids.patient), 'uploaded file became an encrypted document');
  assert.equal((await get('SELECT status FROM form_assignments WHERE id = ?', assignment.id)).status, 'submitted');
});

test('3-6. the practitioner reviews it and builds a care plan with a preparation, product and lesson', async () => {
  const page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=forms`);
  assert.match(page.text, /Poor sleep for months/);
  assert.match((await ann.get('/admin/clinic/inbox')).text, /New patient intake/);
  const sub = await get('SELECT id FROM form_submissions WHERE patient_id = ?', ids.patient);
  await ann.post(`/admin/clinic/patients/${ids.patient}/forms/${sub.id}/review`, {}, `/admin/clinic/patients/${ids.patient}?tab=forms`);
  assert.ok((await get('SELECT reviewed_at FROM form_submissions WHERE id = ?', sub.id)).reviewed_at);
  // Lesson with a quiz.
  let res = await upload(owner, '/admin/education/lessons/new', { title: 'Building a bedtime routine', kind: 'lesson', status: 'published', body_html: '<p>Keep a regular bedtime.</p>',
    'questions[0][question]': 'What helps most?', 'questions[0][options]': 'A regular bedtime\nLate screens', 'questions[0][correct]': '1' }, null, '/admin/education/lessons/new');
  ids.lesson = Number(res.location.split('/').pop());
  // An approved formula and a product.
  const m = await get("SELECT id FROM materials LIMIT 1") || null;
  await run("INSERT INTO materials (name, kind, pack_size, pack_unit, pack_cost) VALUES ('Test herb', 'herb', 1, 'kg', 1000)");
  const herbMat = (await get("SELECT id FROM materials WHERE name = 'Test herb'")).id;
  res = await owner.post('/admin/formulas/new', { name: 'Evening tea', category: 'tea', entry_mode: 'parts', yield_qty: '100', yield_unit: 'g', 'lines[0][material_id]': herbMat, 'lines[0][quantity]': '1' }, '/admin/formulas/new');
  ids.formula = Number(res.location.split('/').pop());
  ids.variant = (await get("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' AND (v.track_inventory = 0 OR v.inventory_qty > 3) LIMIT 1")).id;
  void m;
  res = await ann.post(`/admin/clinic/patients/${ids.patient}/plans`, { title: 'Sleep support plan', start_date: '2026-01-01' }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  ids.plan = Number(new URL(ctx.base + res.location).searchParams.get('plan'));
  const pb = `/admin/clinic/patients/${ids.patient}/plans/${ids.plan}`;
  // Unapproved formulas are refused.
  await ann.post(`${pb}/items`, { kind: 'formula', title: 'Evening tea', formula_id: ids.formula }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM care_plan_items WHERE plan_id = ?', ids.plan)).n, 0);
  await owner.post(`/admin/formulas/${ids.formula}/approve`, { reviewed_safety: '1' }, `/admin/formulas/${ids.formula}`);
  await ann.post(`${pb}/items`, { kind: 'formula', title: 'Evening tea', formula_id: ids.formula, dose: '1 cup', frequency: 'daily', timing: 'after dinner', preparation: 'Steep 1 tsp for 10 minutes', is_task: '1' }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  await ann.post(`${pb}/items`, { kind: 'routine', title: 'Screens off by 9pm', frequency: 'daily' }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  await ann.post(`${pb}/items`, { kind: 'product', title: 'Tea to buy', variant_id: ids.variant }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  await ann.post(`${pb}/items`, { kind: 'lesson', title: 'Read about routines', lesson_id: ids.lesson }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  const items = await all('SELECT * FROM care_plan_items WHERE plan_id = ? ORDER BY position', ids.plan);
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => !/Evening tea|Screens/.test(i.content_enc)), 'plan content is encrypted');
  assert.ok(await get('SELECT 1 FROM lesson_assignments WHERE patient_id = ? AND lesson_id = ?', ids.patient, ids.lesson), 'adding a lesson assigns it');
  // Not shared yet: the patient can't see it.
  assert.equal((await patient.get(`/account/clinic/plans/${ids.plan}`)).status, 404);
  await ann.post(pb, { title: 'Sleep support plan', goals: 'Fall asleep within 30 minutes', status: 'active', shared: '1', start_date: '2026-01-01' }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  // Editing an active plan keeps the previous version.
  await ann.post(`${pb}/items`, { kind: 'follow_up', title: 'Follow-up in 4 weeks' }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  assert.ok(await get('SELECT 1 FROM care_plan_versions WHERE plan_id = ? AND version = 1', ids.plan));
  assert.equal((await get('SELECT version FROM care_plans WHERE id = ?', ids.plan)).version, 2);
  assert.equal((await ann.get(`${pb}/versions/1`)).status, 200);
  assert.equal((await ann.get(`${pb}/print`)).status, 200);
});

test('7-8. the patient uses the portal: tasks, lesson and quiz, journal, product to cart, message, upload', async () => {
  let page = await patient.get('/account/clinic');
  assert.match(page.text, /Sleep support plan/);
  assert.match(page.text, /Screens off by 9pm/);
  page = await patient.get(`/account/clinic/plans/${ids.plan}`);
  assert.match(page.text, /Steep 1 tsp for 10 minutes/);
  const task = await get("SELECT id FROM care_plan_items WHERE plan_id = ? AND kind = 'routine'", ids.plan);
  await patient.post(`/account/clinic/plans/${ids.plan}/items/${task.id}/done`, {}, `/account/clinic/plans/${ids.plan}`);
  assert.ok(await get('SELECT 1 FROM care_plan_completions WHERE item_id = ?', task.id));
  const product = await get("SELECT id FROM care_plan_items WHERE plan_id = ? AND kind = 'product'", ids.plan);
  let res = await patient.post(`/account/clinic/plans/${ids.plan}/items/${product.id}/cart`, {}, `/account/clinic/plans/${ids.plan}`);
  assert.equal(res.location, '/cart');
  assert.equal(JSON.parse((await patient.get('/cart.json')).text).item_count, 1);
  page = await patient.get(`/account/clinic/learning/${ids.lesson}`);
  assert.match(page.text, /Keep a regular bedtime/);
  const q = await get('SELECT id FROM lesson_questions WHERE lesson_id = ?', ids.lesson);
  await patient.post(`/account/clinic/learning/${ids.lesson}/complete`, { [`q_${q.id}`]: '0' }, `/account/clinic/learning/${ids.lesson}`);
  const prog = await get('SELECT * FROM lesson_progress WHERE patient_id = ? AND lesson_id = ?', ids.patient, ids.lesson);
  assert.equal(prog.quiz_score, 1);
  assert.ok(prog.completed_at);
  await patient.post('/account/clinic/journal', { kind: 'wellness', sleep: '4', energy: '5', note: 'Woke twice' }, '/account/clinic/journal');
  await patient.post('/account/clinic/journal', { kind: 'wellness', sleep: '7', energy: '6' }, '/account/clinic/journal');
  await patient.post('/account/clinic/messages', { subject: 'Question about my tea', body: 'Can I drink it with milk?' }, '/account/clinic/messages');
  const staffMail = await get("SELECT * FROM email_outbox WHERE to_address = 'ann@example.com' ORDER BY id DESC LIMIT 1");
  assert.ok(staffMail);
  assert.doesNotMatch(staffMail.html, /milk|tea/i, 'notification email has no message content');
  res = await upload(patient, '/account/clinic/documents', { kind: 'photo', title: 'Rash photo' }, { field: 'file', body: Buffer.from('\x89PNG demo'), type: 'image/png', name: 'rash.png' }, '/account/clinic/documents');
  assert.equal(res.location, '/account/clinic/documents');
  // Lessons not assigned to them are not visible.
  await run("INSERT INTO lessons (title, status) VALUES ('Unassigned lesson', 'published')");
  const unassigned = (await get("SELECT id FROM lessons WHERE title = 'Unassigned lesson'")).id;
  assert.equal((await patient.get(`/account/clinic/learning/${unassigned}`)).status, 404);
});

test('9. the practitioner reviews progress and replies; the patient is notified without content', async () => {
  let page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=progress`);
  assert.match(page.text, /Woke twice/);
  assert.match(page.text, /latest <strong>7<\/strong>/);
  page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=plans&plan=${ids.plan}`);
  assert.match(page.text, /Task completion/);
  page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=learning`);
  assert.match(page.text, /1\/1/);
  const thread = await get('SELECT id FROM message_threads WHERE patient_id = ?', ids.patient);
  page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=messages&thread=${thread.id}`);
  assert.match(page.text, /Can I drink it with milk\?/);
  await ann.post(`/admin/clinic/patients/${ids.patient}/messages`, { thread_id: thread.id, body: 'Yes, a splash is fine.' }, `/admin/clinic/patients/${ids.patient}?tab=messages`);
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'robin@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /New secure message/);
  assert.doesNotMatch(mail.html, /splash/);
  page = await patient.get('/account/clinic/messages');
  assert.match(page.text, /Yes, a splash is fine\./);
  assert.match((await ann.get(`/admin/clinic/patients/${ids.patient}?tab=documents`)).text, /Rash photo/);
});

test('patients see only their own records, and only what is shared', async () => {
  other = new Client(ctx.base);
  await other.post('/account/register', { first_name: 'Sam', last_name: 'Oak', email: 'sam@example.com', password: 'password123' }, '/account/register');
  await ann.post('/admin/clinic/patients/new', { email: 'sam@example.com', consent: '1' }, '/admin/clinic/patients/new');
  assert.equal((await other.get('/account/clinic')).status, 200);
  assert.doesNotMatch((await other.get('/account/clinic')).text, /Sleep support plan/);
  assert.equal((await other.get(`/account/clinic/plans/${ids.plan}`)).status, 404);
  const doc = await get('SELECT id FROM patient_documents WHERE patient_id = ? LIMIT 1', ids.patient);
  assert.equal((await other.get(`/account/clinic/documents/${doc.id}`)).status, 404);
  const thread = await get('SELECT id FROM message_threads WHERE patient_id = ?', ids.patient);
  assert.doesNotMatch((await other.get(`/account/clinic/messages?thread=${thread.id}`)).text, /splash/);
  // Staff-only documents aren't visible to the patient until shared.
  const staffDoc = await run(`INSERT INTO patient_documents (patient_id, kind, title_enc, storage_key, mime, size_bytes) VALUES (?, 'document', ?, 'patients/x/notshared', 'text/plain', 1)`, ids.patient, vault.seal('Internal letter'));
  void staffDoc;
  assert.doesNotMatch((await patient.get('/account/clinic/documents')).text, /Internal letter/);
  // Clinical notes never appear in the portal.
  await ann.post(`/admin/clinic/patients/${ids.patient}/notes`, { kind: 'internal', text: 'Private practitioner observation', sign: '1' }, `/admin/clinic/patients/${ids.patient}?tab=notes`);
  for (const url of ['/account/clinic', `/account/clinic/plans/${ids.plan}`, '/account/clinic/documents', '/account/clinic/messages', '/account/clinic/journal']) {
    assert.doesNotMatch((await patient.get(url)).text, /Private practitioner observation/, url);
  }
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'portal.plan_viewed' AND actor_type = 'customer'"));
});
