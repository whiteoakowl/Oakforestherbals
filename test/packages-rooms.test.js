'use strict';
// Rooms, session packages and automatic video links.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');
const scheduling = require('../src/scheduling');

const TZ = 'America/New_York';
let ctx;
let owner;
let client;
const ids = {};

function nextWeekday(wd) {
  const base = scheduling.utcToZoned(new Date(), TZ).day;
  for (let i = 3; i < 11; i++) { const d = scheduling.addDays(base, i); if (new Date(`${d}T12:00:00Z`).getUTCDay() === wd) return d; }
  throw new Error('unreachable');
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  for (const [name, email] of [['Ann Herbalist', 'ann@example.com'], ['Ben Herbalist', 'ben@example.com']]) {
    await owner.post('/admin/settings/staff', { name, email, password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  }
  ids.ann = (await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id;
  ids.ben = (await get("SELECT id FROM staff WHERE email = 'ben@example.com'")).id;
  await owner.post('/admin/schedule/settings', { timezone: TZ, min_notice_hours: '1', max_days_ahead: '60', cancel_hours: '24', slot_step_min: '60', reminder_hours: '24', location: '1 Forest Lane', video_provider: 'jitsi' }, '/admin/schedule/hours');
  for (const sid of [ids.ann, ids.ben]) await run("INSERT INTO practitioner_hours (staff_id, weekday, start_time, end_time) VALUES (?, 1, '09:00', '11:00')", sid);
  await run('INSERT INTO practitioner_profiles (staff_id, display_name, accepts_bookings, public_profile) VALUES (?, ?, 1, 1), (?, ?, 1, 1)', ids.ann, 'Ann', ids.ben, 'Ben');
  await owner.post('/admin/schedule/types/new', { name: 'Acupuncture', kind: 'follow_up', duration_min: '60', price: '80.00', mode: 'in_person', capacity: '1', online_booking: '1', active: '1', needs_room: '1', staff_ids: [String(ids.ann), String(ids.ben)] }, '/admin/schedule/types');
  ids.type = (await get("SELECT id FROM appointment_types WHERE name = 'Acupuncture'")).id;
  await owner.post('/admin/schedule/types/new', { name: 'Video check-in', kind: 'follow_up', duration_min: '30', price: '40.00', mode: 'virtual', capacity: '1', online_booking: '1', active: '1', staff_ids: String(ids.ann) }, '/admin/schedule/types');
  ids.video = (await get("SELECT id FROM appointment_types WHERE name = 'Video check-in'")).id;
  ids.monday = nextWeekday(1);
  client = new Client(ctx.base);
  await client.post('/account/register', { first_name: 'Rue', last_name: 'Hart', email: 'rue@example.com', password: 'password123' }, '/account/register');
  ids.customer = (await get("SELECT id FROM customers WHERE email = 'rue@example.com'")).id;
});
after(() => ctx.close());

test('with one room, two practitioners can’t both book the same hour for a room-needing type', async () => {
  await owner.post('/admin/schedule/rooms', { name: 'Room 1' }, '/admin/schedule/rooms');
  ids.room1 = (await get("SELECT id FROM rooms WHERE name = 'Room 1'")).id;
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', ids.type);
  assert.deepEqual((await scheduling.slots(type, ids.ann, ids.monday, ids.monday)).map((s) => s.time), ['09:00', '10:00']);
  const nine = scheduling.zonedToUtc(ids.monday, '09:00', TZ);
  const a1 = await scheduling.book({ type, staffId: ids.ann, customerId: ids.customer, start: nine, mode: 'in_person' });
  assert.equal((await get('SELECT room_id FROM appointments WHERE id = ?', a1)).room_id, ids.room1, 'room chosen automatically');
  // Ben is free at 09:00 but the only room isn't.
  assert.deepEqual((await scheduling.slots(type, ids.ben, ids.monday, ids.monday)).map((s) => s.time), ['10:00']);
  await assert.rejects(scheduling.book({ type, staffId: ids.ben, customerId: ids.customer, start: nine, mode: 'in_person', staffOverride: true }), /No room is free/);
  // A second room frees it up.
  await owner.post('/admin/schedule/rooms', { name: 'Room 2' }, '/admin/schedule/rooms');
  assert.deepEqual((await scheduling.slots(type, ids.ben, ids.monday, ids.monday)).map((s) => s.time), ['09:00', '10:00']);
  const a2 = await scheduling.book({ type, staffId: ids.ben, customerId: ids.customer, start: nine, mode: 'in_person' });
  ids.room2 = (await get("SELECT id FROM rooms WHERE name = 'Room 2'")).id;
  assert.equal((await get('SELECT room_id FROM appointments WHERE id = ?', a2)).room_id, ids.room2);
  // Moving Ben's appointment into Room 1 is refused; the page shows the room.
  const res = await owner.post(`/admin/schedule/appointments/${a2}/room`, { room_id: String(ids.room1) }, `/admin/schedule/appointments/${a2}`);
  assert.equal((await get('SELECT room_id FROM appointments WHERE id = ?', a2)).room_id, ids.room2);
  assert.match((await owner.get(res.location)).text, /That room is taken/);
  await run("UPDATE appointments SET status = 'cancelled' WHERE id IN (?, ?)", a1, a2);
});

test('online appointments get a private video link automatically', async () => {
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', ids.video);
  const id = await scheduling.book({ type, staffId: ids.ann, customerId: ids.customer, start: scheduling.zonedToUtc(ids.monday, '10:00', TZ), mode: 'virtual', staffOverride: true });
  const a = await get('SELECT video_link, room_id FROM appointments WHERE id = ?', id);
  assert.match(a.video_link, /^https:\/\/meet\.jit\.si\/oak-forest-herbals-[0-9a-f]{18}$/);
  assert.equal(a.room_id, null);
  await run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", id);
});

test('a package bought online starts when paid, pays for bookings, and gets sessions back on cancellation', async () => {
  await owner.post('/admin/schedule/packages', { name: 'Five acupuncture sessions', sessions: '2', price: '150.00', valid_days: '90', type_ids: String(ids.type), online_sale: '1' }, '/admin/schedule/packages');
  const pkg = await get("SELECT * FROM service_packages WHERE name = 'Five acupuncture sessions'");
  assert.match((await client.get('/book/packages')).text, /Five acupuncture sessions/);
  let res = await client.post(`/book/packages/${pkg.id}`, {}, '/book/packages');
  assert.match(res.location, /^\/invoices\//);
  let cp = await get('SELECT * FROM client_packages WHERE customer_id = ?', ids.customer);
  assert.equal(cp.status, 'pending');
  // Paid (e.g. at the desk): the package starts, with an expiry.
  await owner.post(`/admin/invoices/${cp.invoice_id}/payments`, { amount: '150.00', method: 'Card' }, `/admin/invoices/${cp.invoice_id}`);
  cp = await get('SELECT * FROM client_packages WHERE id = ?', cp.id);
  assert.equal(cp.status, 'active');
  assert.ok(cp.expires_on);
  assert.match((await client.get('/account/appointments')).text, /2 of 2 sessions left/);

  // Book online using the package: no invoice, price 0.
  const page = await client.get(`/book/${ids.type}?staff=${ids.ann}&from=${ids.monday}`);
  assert.match(page.text, /a session from Five acupuncture sessions \(2 left\)/);
  await client.post(`/book/${ids.type}`, { staff_id: String(ids.ann), start: scheduling.zonedToUtc(ids.monday, '10:00', TZ).toISOString(), package_id: String(cp.id) }, `/book/${ids.type}`);
  const appt = await get("SELECT * FROM appointments WHERE customer_id = ? AND status = 'booked' ORDER BY id DESC LIMIT 1", ids.customer);
  assert.equal(appt.price, 0);
  assert.equal(appt.invoice_id, null);
  assert.equal((await get('SELECT sessions_used FROM client_packages WHERE id = ?', cp.id)).sessions_used, 1);
  // Staff booking uses the last session; the package is then used up.
  await owner.post('/admin/schedule/appointments/new', { type_id: String(ids.type), staff_id: String(ids.ben), customer_id: String(ids.customer), day: ids.monday, time: '09:00', mode: 'in_person', use_package: '1', invoice: '1' }, '/admin/schedule/appointments/new');
  assert.equal((await get('SELECT status, sessions_used FROM client_packages WHERE id = ?', cp.id)).status, 'used');
  const staffAppt = await get("SELECT * FROM appointments WHERE customer_id = ? AND staff_id = ? AND status = 'booked'", ids.customer, ids.ben);
  assert.equal(staffAppt.invoice_id, null, 'no invoice for a package session');
  // Cancelling gives the session back.
  await owner.post(`/admin/schedule/appointments/${staffAppt.id}`, { status: 'cancelled', video_link: '', location: '' }, `/admin/schedule/appointments/${staffAppt.id}`);
  const after_ = await get('SELECT status, sessions_used FROM client_packages WHERE id = ?', cp.id);
  assert.deepEqual([after_.status, after_.sessions_used], ['active', 1]);
  // Packages don't cover other types.
  const { usableFor } = require('../src/packages');
  assert.equal((await usableFor(ids.customer, ids.video)).length, 0);
  assert.equal((await usableFor(ids.customer, ids.type)).length, 1);
  // Expired packages can't be used.
  await run("UPDATE client_packages SET expires_on = CURRENT_DATE - 1 WHERE id = ?", cp.id);
  assert.equal((await usableFor(ids.customer, ids.type)).length, 0);
  assert.equal((await get('SELECT status FROM client_packages WHERE id = ?', cp.id)).status, 'expired');
  void all;
});

test('staff sell a package at the desk, paid now', async () => {
  const pkg = await get("SELECT id FROM service_packages LIMIT 1");
  const res = await owner.post('/admin/schedule/packages/sell', { email: 'rue@example.com', package_id: String(pkg.id), paid_now: '1', method: 'Cash' }, '/admin/schedule/packages');
  assert.match(res.location, /^\/admin\/invoices\/\d+$/);
  const cp = await get('SELECT * FROM client_packages ORDER BY id DESC LIMIT 1');
  assert.equal(cp.status, 'active');
  assert.equal((await get('SELECT status FROM invoices WHERE id = ?', cp.invoice_id)).status, 'paid');
  assert.match((await owner.get('/admin/schedule/packages')).text, /Rue Hart/);
});
