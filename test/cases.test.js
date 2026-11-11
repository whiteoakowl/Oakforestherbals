'use strict';
// Cases (episodes of care) and referrers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all } = require('../src/db');

let ctx;
let owner;
let ann;
let ben;
const ids = {};

async function login(email) {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  return c;
}

before(async () => {
  ctx = await start();
  owner = await login('owner@example.com');
  for (const [name, email] of [['Ann Herbalist', 'ann@example.com'], ['Ben Herbalist', 'ben@example.com']]) {
    await owner.post('/admin/settings/staff', { name, email, password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  }
  ann = await login('ann@example.com');
  ben = await login('ben@example.com');
  ids.ann = (await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id;
  const res = await ann.post('/admin/clinic/patients/new', { email: 'iris@example.com', first_name: 'Iris', last_name: 'Bloom', consent: '1' }, '/admin/clinic/patients/new');
  ids.patient = Number(res.location.split('/').pop());
  await owner.post('/admin/schedule/types/new', { name: 'Follow-up', kind: 'follow_up', duration_min: '30', price: '60.00', mode: 'in_person', capacity: '1', online_booking: '1', active: '1', staff_ids: String(ids.ann) }, '/admin/schedule/types');
  ids.type = (await get("SELECT id FROM appointment_types WHERE name = 'Follow-up'")).id;
});
after(() => ctx.close());

test('a practitioner keeps a referrer directory and opens a case with a referral', async () => {
  await ann.post('/admin/clinic/referrers', { name: 'Dr Sam Reed', organisation: 'Elm Street Medical', kind: 'doctor', email: 'reed@example.com', address: '1 Elm St' }, '/admin/clinic/referrers');
  ids.referrer = (await get("SELECT id FROM referrers WHERE name = 'Dr Sam Reed'")).id;
  const res = await ann.post(`/admin/clinic/patients/${ids.patient}/cases`, { title: 'Sleep and stress', referrer_id: String(ids.referrer), referral_date: '2026-10-01', reason: 'Poor sleep for 6 months', goals: 'Sleep 7 hours' }, `/admin/clinic/patients/${ids.patient}?tab=cases`);
  assert.match(res.location, /\/cases\/\d+$/);
  ids.case = Number(res.location.split('/').pop());
  const row = await get('SELECT * FROM clinic_cases WHERE id = ?', ids.case);
  assert.equal(row.status, 'open');
  assert.doesNotMatch(row.details_enc, /Poor sleep/, 'clinical detail encrypted');
  const page = await ann.get(`/admin/clinic/patients/${ids.patient}?tab=cases`);
  assert.match(page.text, /Sleep and stress/);
  assert.match(page.text, /referred by Dr Sam Reed/);
});

test('notes, care plans, appointments and invoices can be filed under the case and appear on it', async () => {
  await ann.post(`/admin/clinic/patients/${ids.patient}/notes`, { kind: 'consultation', text: 'Initial assessment for sleep', case_id: String(ids.case), sign: '1' }, `/admin/clinic/patients/${ids.patient}?tab=notes`);
  await ann.post(`/admin/clinic/patients/${ids.patient}/notes`, { kind: 'internal', text: 'Unrelated note', sign: '0' }, `/admin/clinic/patients/${ids.patient}?tab=notes`);
  await ann.post(`/admin/clinic/patients/${ids.patient}/plans`, { title: 'Sleep plan', case_id: String(ids.case) }, `/admin/clinic/patients/${ids.patient}?tab=plans`);
  const customer = (await get('SELECT customer_id FROM patients WHERE id = ?', ids.patient)).customer_id;
  const form = await ann.get(`/admin/schedule/appointments/new?patient=${ids.patient}&case=${ids.case}`);
  assert.match(form.text, /Case: <strong>Sleep and stress/);
  const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await ann.post('/admin/schedule/appointments/new', { type_id: String(ids.type), customer_id: String(customer), case_id: String(ids.case), day, time: '10:00', mode: 'in_person', override: '1', invoice: '1' }, '/admin/schedule/appointments/new');
  const appt = await get('SELECT * FROM appointments WHERE customer_id = ?', customer);
  assert.equal(appt.case_id, ids.case);
  assert.equal((await get('SELECT case_id FROM invoices WHERE appointment_id = ?', appt.id)).case_id, ids.case, 'the visit invoice follows the case');
  // A case id that belongs to someone else is ignored.
  const other = await ann.post('/admin/clinic/patients/new', { email: 'other@example.com', first_name: 'Oak', last_name: 'Tree', consent: '1' }, '/admin/clinic/patients/new');
  const otherId = Number(other.location.split('/').pop());
  await ann.post(`/admin/clinic/patients/${otherId}/notes`, { kind: 'internal', text: 'Sneaky', case_id: String(ids.case), sign: '0' }, `/admin/clinic/patients/${otherId}?tab=notes`);
  assert.equal((await get("SELECT case_id FROM clinical_notes WHERE patient_id = ?", otherId)).case_id, null);

  const page = await ann.get(`/admin/clinic/patients/${ids.patient}/cases/${ids.case}`);
  assert.match(page.text, /Initial assessment for sleep/);
  assert.doesNotMatch(page.text, /Unrelated note/);
  assert.match(page.text, /Sleep plan/);
  assert.match(page.text, /Follow-up/);
  assert.match(page.text, /Total billed:<\/strong> \$60\.00/);
});

test('the referral report is saved encrypted and printable; cases close and reopen', async () => {
  const base = `/admin/clinic/patients/${ids.patient}/cases/${ids.case}`;
  let page = await ann.get(`${base}/report`);
  assert.match(page.text, /Thank you for referring Iris Bloom/);
  assert.match(page.text, /Poor sleep for 6 months/);
  await ann.post(`${base}/report`, { body: 'Iris has improved. Sleeping 7 hours most nights.' }, `${base}/report`);
  assert.doesNotMatch((await get('SELECT report_enc FROM clinic_cases WHERE id = ?', ids.case)).report_enc, /improved/);
  page = await ann.get(`${base}/report?print=1`);
  assert.match(page.text, /Dr Sam Reed/);
  assert.match(page.text, /Re: Iris Bloom/);
  assert.match(page.text, /Sleeping 7 hours/);
  await ann.post(base, { action: 'close', closed_reason: 'Goals met' }, base);
  assert.equal((await get('SELECT status, closed_reason FROM clinic_cases WHERE id = ?', ids.case)).closed_reason, 'Goals met');
  await ann.post(base, { action: 'reopen' }, base);
  assert.equal((await get('SELECT status FROM clinic_cases WHERE id = ?', ids.case)).status, 'open');
  // Referrer list counts the case.
  page = await ann.get('/admin/clinic/referrers');
  assert.match(page.text, /Dr Sam Reed/);
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'patient.case_report_saved'"));
});

test('a practitioner who isn’t assigned can’t open the case', async () => {
  assert.equal((await ben.get(`/admin/clinic/patients/${ids.patient}/cases/${ids.case}`)).status, 404);
  assert.equal((await ben.get(`/admin/clinic/patients/${ids.patient}/cases/${ids.case}/report?print=1`)).status, 404);
  const res = await ben.post(`/admin/clinic/patients/${ids.patient}/cases/${ids.case}`, { action: 'close' }, '/admin');
  assert.equal(res.status, 404);
  assert.equal((await get('SELECT status FROM clinic_cases WHERE id = ?', ids.case)).status, 'open');
  assert.equal((await all('SELECT id FROM clinic_cases')).length, 1);
});
