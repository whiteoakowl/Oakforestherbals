'use strict';
// Communications, automation, notifications, dashboard widgets and the AI assistant.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run, insert } = require('../src/db');
const vault = require('../src/vault');
const settings = require('../src/settings');
const automation = require('../src/automation');
const comms = require('../src/comms');
const permissions = require('../src/permissions');
const assistant = require('../src/assistant');

let ctx;
let owner;
let ann;
let customer;
const ids = {};

async function login(email) {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  return c;
}
async function staffObj(email) {
  const s = await get('SELECT id, name, role FROM staff WHERE email = ?', email);
  return { ...s, permissions: await permissions.forRole(s.role) };
}

before(async () => {
  ctx = await start();
  owner = await login('owner@example.com');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  await owner.post('/admin/settings/staff', { name: 'Cass Service', email: 'cass@example.com', password: 'password123', role: 'customer_service' }, '/admin/settings/staff');
  ann = await login('ann@example.com');
  customer = new Client(ctx.base);
  await customer.post('/account/register', { first_name: 'Robin', last_name: 'Fern', email: 'robin@example.com', password: 'password123' }, '/account/register');
  ids.customer = (await get("SELECT id FROM customers WHERE email = 'robin@example.com'")).id;
  ids.ann = (await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id;
});
after(() => { assistant.setClient(null); return ctx.close(); });

test('a customer sets reminder preferences; SMS needs a valid number and an opt-in', async () => {
  let res = await customer.post('/account/preferences', { email_reminders: '1', sms_opt_in: '1', sms_phone: '12' }, '/account');
  assert.equal(res.location, '/account');
  assert.equal((await get('SELECT sms_opt_in FROM customers WHERE id = ?', ids.customer)).sms_opt_in, 0, 'invalid number is refused');
  res = await customer.post('/account/preferences', { email_reminders: '1', sms_opt_in: '1', sms_phone: '+1 (555) 123-4567' }, '/account');
  const c = await get('SELECT sms_opt_in, sms_opt_in_at, phone, email_reminders FROM customers WHERE id = ?', ids.customer);
  assert.equal(c.sms_opt_in, 1);
  assert.ok(c.sms_opt_in_at, 'opt-in time is recorded');
  assert.equal(c.phone, '+15551234567');
});

test('appointment reminders go out once, by email and (opted-in) SMS, with no clinical details', async () => {
  const soon = new Date(Date.now() + 3 * 3600000);
  ids.appt = await insert(`INSERT INTO appointments (type_name, staff_id, customer_id, starts_at, ends_at, status, notes_enc)
    VALUES ('Follow-up consultation', ?, ?, ?, ?, 'booked', ?)`, ids.ann, ids.customer, soon.toISOString(), new Date(soon.getTime() + 1800000).toISOString(), vault.seal({ text: 'SECRET-CLINICAL-NOTE' }));
  await settings.save('automation', { appointment_reminders: true });
  const before = (await get('SELECT COUNT(*) AS n FROM email_outbox')).n;
  await automation.runAll('test');
  await automation.runAll('test again');
  const emails = await all("SELECT * FROM email_outbox WHERE template = 'appointment_reminder'");
  assert.equal(emails.length, 1, 'sent exactly once across two runs');
  assert.equal((await get('SELECT COUNT(*) AS n FROM email_outbox')).n, before + 1);
  assert.match(emails[0].subject, /Reminder/);
  assert.doesNotMatch(JSON.stringify(emails[0]), /SECRET-CLINICAL-NOTE/);
  const sms = await all("SELECT * FROM sms_outbox WHERE template = 'appointment_reminder'");
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to_number, '+15551234567');
  assert.equal(sms[0].status, 'logged', 'without Twilio settings the SMS is only logged');
  assert.doesNotMatch(sms[0].body, /SECRET-CLINICAL-NOTE/);
  assert.ok((await get('SELECT reminder_sent_at FROM appointments WHERE id = ?', ids.appt)).reminder_sent_at);
  const runs = await all('SELECT * FROM automation_runs ORDER BY id');
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.finished_at && !r.error));
});

test('customers who turn reminders off, or never opted in to SMS, get none', async () => {
  await run('UPDATE customers SET email_reminders = 0, sms_opt_in = 0 WHERE id = ?', ids.customer);
  const soon = new Date(Date.now() + 2 * 3600000);
  await insert(`INSERT INTO appointments (type_name, staff_id, customer_id, starts_at, ends_at, status) VALUES ('Check-in', ?, ?, ?, ?, 'booked')`,
    ids.ann, ids.customer, soon.toISOString(), new Date(soon.getTime() + 1800000).toISOString());
  const e = (await get("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'appointment_reminder'")).n;
  const s = (await get('SELECT COUNT(*) AS n FROM sms_outbox')).n;
  await automation.runAll('test');
  assert.equal((await get("SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'appointment_reminder'")).n, e);
  assert.equal((await get('SELECT COUNT(*) AS n FROM sms_outbox')).n, s);
});

test('templates are editable, placeholders are HTML-escaped, and reset restores the default', async () => {
  const from = '/admin/communications/templates/invoice_sent';
  let res = await owner.post(from, { subject: 'Invoice {{number}} from {{store}}', body: '<p>Hello {{first_name}}</p>', sms_body: '', email_enabled: '1' }, from);
  assert.equal(res.location, from);
  assert.equal((await comms.template('invoice_sent')).subject, 'Invoice {{number}} from {{store}}');
  assert.equal(comms.fill('<p>{{first_name}}</p>', { first_name: '<script>x</script>' }, true), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  await comms.send('invoice_sent', { email: 'x@example.com', first_name: 'Max' }, { number: '77' });
  assert.equal((await get("SELECT subject FROM email_outbox WHERE to_address = 'x@example.com' ORDER BY id DESC LIMIT 1")).subject.startsWith('Invoice 77 from'), true);
  await owner.post(from, { reset: '1' }, from);
  assert.equal(await get("SELECT 1 FROM notification_templates WHERE key = 'invoice_sent'"), undefined);
  // Only staff with settings access can edit templates.
  assert.equal((await ann.get('/admin/communications')).status, 403);
  assert.equal((await ann.get('/admin/communications/notifications')).status, 200, 'every staff member has a notification centre');
});

test('notifications reach the right staff, the daily digest runs once a day, and reads are per person', async () => {
  await comms.notifyStaff({ kind: 'test', title: 'For inventory people', permission: 'inventory.manage', dedupe: 'inv-1' });
  await comms.notifyStaff({ kind: 'test', title: 'For inventory people', permission: 'inventory.manage', dedupe: 'inv-1' });
  await comms.notifyStaff({ kind: 'test', title: 'Only for Ann', staffId: ids.ann });
  const annS = await staffObj('ann@example.com');
  const cass = await staffObj('cass@example.com');
  const ownerS = await staffObj('owner@example.com');
  assert.deepEqual((await comms.forStaff(annS)).map((n) => n.title), ['Only for Ann'], 'practitioners do not see inventory alerts');
  assert.equal((await comms.forStaff(cass)).length, 0);
  assert.equal((await comms.forStaff(ownerS)).filter((n) => n.title === 'For inventory people').length, 1, 'deduplicated');
  await ann.post('/admin/communications/notifications/read', {}, '/admin/communications/notifications');
  assert.equal((await comms.forStaff(annS, { unreadOnly: true })).length, 0);
  assert.equal((await comms.forStaff(ownerS, { unreadOnly: true })).filter((n) => n.title === 'For inventory people').length, 1, 'reading is per person');
  await settings.save('automation', { last_digest_day: '' });
  const first = await automation.dailyDigest(new Date());
  const second = await automation.dailyDigest(new Date());
  assert.ok(!first.skipped);
  assert.equal(second.skipped, true);
});

test('the dashboard shows only widgets the role allows, and each person can hide theirs', async () => {
  let page = await ann.get('/admin');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Revenue by month/);
  page = await owner.get('/admin');
  assert.match(page.text, /Customise|Customize|widgets/i);
  await owner.post('/admin/dashboard/widgets', { show: 'notifications' }, '/admin');
  const hidden = JSON.parse((await get("SELECT value FROM staff_preferences WHERE key = 'dashboard_hidden' AND staff_id = (SELECT id FROM staff WHERE email = 'owner@example.com')")).value);
  assert.ok(hidden.includes('revenue') && !hidden.includes('notifications'));
  assert.equal(await get("SELECT 1 FROM staff_preferences WHERE staff_id = ?", ids.ann), undefined, 'other staff are unaffected');
});

/* ---------- AI assistant ---------- */

test('assistant tools follow the asking person’s permissions; patient data needs assistant.clinic', async () => {
  const annS = await staffObj('ann@example.com');
  const cass = await staffObj('cass@example.com');
  const ownerS = await staffObj('owner@example.com');
  assert.deepEqual(assistant.toolsFor(annS).map((t) => t.name), ['search_herbs', 'herb_profile', 'formula']);
  assert.deepEqual(assistant.toolsFor(cass).map((t) => t.name), [], 'customer service has none of the data roles');
  assert.ok(assistant.toolsFor(ownerS).some((t) => t.name === 'patient_summary'));
  assert.deepEqual(await assistant.runTool('sales_summary', { days: 30 }, annS), { error: 'Permission missing for this information.' });
  assert.deepEqual(await assistant.runTool('patient_summary', { patient: 'Robin' }, annS), { error: 'Permission missing for this information.' });
  // Cass's role doesn't include the assistant at all.
  const c = await login('cass@example.com');
  assert.equal((await c.get('/admin/assistant')).status, 403);
});

test('patient summaries only cover patients the person can see', async () => {
  let res = await owner.post('/admin/clinic/patients/new', { email: 'robin@example.com', consent: '1' }, '/admin/clinic/patients/new');
  ids.patient = Number(res.location.split('/').pop());
  await insert('INSERT INTO patient_health_items (patient_id, category, data_enc, recorded_by) VALUES (?, ?, ?, ?)', ids.patient, 'allergy', vault.seal({ title: 'Ragweed' }), (await staffObj('owner@example.com')).id);
  const ownerS = await staffObj('owner@example.com');
  const out = await assistant.runTool('patient_summary', { patient: 'Robin' }, ownerS);
  assert.equal(out.number, ids.patient);
  assert.deepEqual(out.health_items, [{ category: 'allergy', title: 'Ragweed' }]);
  // A practitioner given assistant.clinic still only sees assigned patients.
  const annS = await staffObj('ann@example.com');
  annS.permissions.add('assistant.clinic');
  assert.deepEqual(await assistant.runTool('patient_summary', { patient: 'Robin' }, annS), { error: 'No patient you can see matches that.' });
  await run('INSERT INTO practitioner_assignments (patient_id, staff_id, is_primary) VALUES (?, ?, 1)', ids.patient, ids.ann);
  assert.equal((await assistant.runTool('patient_summary', { patient: String(ids.patient) }, annS)).name, 'Robin Fern');
});

test('herb answers come only from the database, with source and evidence level', async () => {
  await owner.post('/admin/herbs/sources/new', { kind: 'book', title: 'Test Materia Medica', authors: 'Example, A.', year: '2020' }, '/admin/herbs/sources/new');
  const src = await get("SELECT id FROM herb_sources WHERE title = 'Test Materia Medica'");
  const page = await owner.get('/admin/herbs/new');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  await fetch(`${ctx.base}/admin/herbs/new`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ _csrf: csrf, status: 'published', common_name: 'Test Flower', latin_name: 'Testus floralis' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const herb = await get("SELECT id, slug FROM herbs WHERE common_name = 'Test Flower'");
  await owner.post(`/admin/herbs/${herb.slug}/safety`, { kind: 'pregnancy', description: 'Test caution text', evidence: 'traditional', source_id: src.id }, `/admin/herbs/${herb.slug}`);
  const annS = await staffObj('ann@example.com');
  const found = await assistant.runTool('search_herbs', { query: 'test flower' }, annS);
  assert.equal(found.herbs[0].slug, herb.slug);
  const prof = await assistant.runTool('herb_profile', { slug: herb.slug }, annS);
  assert.deepEqual(prof.safety, [{ kind: 'pregnancy', detail: 'Test caution text', evidence: 'traditional', source: 'Test Materia Medica (Example, A.), 2020' }]);
  assert.equal((await assistant.runTool('herb_profile', { slug: 'made-up-herb' }, annS)).error, 'No published herb with that slug.');
});

test('the assistant page runs the tool loop, records use without content, and explains a missing key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assistant.setClient(null);
  let page = await ann.get('/admin/assistant');
  assert.match(page.text, /ANTHROPIC_API_KEY/);
  const calls = [];
  assistant.setClient({ beta: { messages: { create: async (params) => {
    calls.push(params);
    if (calls.length === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_herbs', input: { query: 'test flower' } }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Test Flower has one traditional pregnancy caution (Test Materia Medica).' }] };
  } } } });
  page = await ann.post('/admin/assistant', { question: 'Any cautions for test flower?' }, '/admin/assistant');
  assert.equal(page.status, 200);
  assert.match(page.text, /one traditional pregnancy caution/);
  assert.match(page.text, /Looked up: search herbs/);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.deepEqual(calls[0].tools.map((t) => t.name), ['search_herbs', 'herb_profile', 'formula']);
  const result = calls[1].messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(result.content, /Test Flower/);
  const log = await get("SELECT * FROM audit_logs WHERE action = 'assistant.asked' ORDER BY id DESC LIMIT 1");
  assert.ok(log);
  assert.doesNotMatch(log.details, /cautions/i, 'the question is not logged');
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test('formula, stock and sales look-ups run for roles that hold them', async () => {
  const ownerS = await staffObj('owner@example.com');
  assert.equal((await assistant.runTool('formula', { name: 'no such formula' }, ownerS)).error, 'No formula you can see matches that name.');
  const m = await insert("INSERT INTO materials (name, kind, pack_size, pack_unit, pack_cost) VALUES ('Test herb (cut)', 'herb', 1000, 'g', 2000)");
  const f = await insert("INSERT INTO formulas (name, category, entry_mode, yield_qty, yield_unit, visibility, owner_id, status) VALUES ('Calm test tea', 'tea', 'parts', 100, 'g', 'shared', ?, 'draft')", ownerS.id);
  await insert("INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, position) VALUES (?, ?, 1, 'g', 0)", f, m);
  const out = await assistant.runTool('formula', { name: 'calm test', scale_qty: 1, scale_unit: 'kg' }, ownerS);
  assert.equal(out.ingredients[0].cost, '2.00', '100 g of a $20/kg herb');
  assert.equal(out.scaled.factor, 10);
  assert.equal(out.scaled.ingredients[0].amount, '1000 g');
  assert.deepEqual(out.ingredients_not_linked_to_herb_database, ['Test herb (cut)']);
  const stock = await assistant.runTool('inventory_status', {}, ownerS);
  assert.ok(Array.isArray(stock.low_stock) && Array.isArray(stock.expired_or_expiring));
  const sales = await assistant.runTool('sales_summary', { days: 9999 }, ownerS);
  assert.equal(sales.days, 365, 'clamped');
  assert.ok(Array.isArray(sales.top_products));
});
