'use strict';
// Phase 8: time zones, availability, online booking, deposits/invoices, cancellation rules,
// rescheduling, waitlist, calendar feed privacy, staff permissions, and financial reporting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');
const scheduling = require('../src/scheduling');

let ctx;
let owner;
let ann;
let client;
const ids = {};
const TZ = 'America/New_York';

// The next date (YYYY-MM-DD, local) that falls on weekday wd (0 = Sunday), at least `min` days away.
function nextWeekday(wd, min = 2) {
  const base = scheduling.utcToZoned(new Date(), TZ).day;
  for (let i = min; i < min + 8; i++) {
    const d = scheduling.addDays(base, i);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === wd) return d;
  }
  throw new Error('unreachable');
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  await owner.post('/admin/settings/staff', { name: 'Ben Herbalist', email: 'ben@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  ids.ann = (await get("SELECT id FROM staff WHERE email = 'ann@example.com'")).id;
  ids.ben = (await get("SELECT id FROM staff WHERE email = 'ben@example.com'")).id;
  ann = new Client(ctx.base);
  await ann.post('/admin/login', { email: 'ann@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await owner.post('/admin/schedule/settings', { timezone: TZ, min_notice_hours: '12', max_days_ahead: '60', cancel_hours: '24', slot_step_min: '30', reminder_hours: '24', location: '1 Forest Lane' }, '/admin/schedule/hours');
});
after(() => ctx.close());

test('time zone conversion handles daylight saving', () => {
  assert.equal(scheduling.zonedToUtc('2026-07-01', '09:00', TZ).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(scheduling.zonedToUtc('2026-12-01', '09:00', TZ).toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(scheduling.zonedToUtc('2026-03-08', '09:00', TZ).toISOString(), '2026-03-08T13:00:00.000Z', 'first morning of DST');
  assert.deepEqual(scheduling.utcToZoned(new Date('2026-12-01T14:30:00Z'), TZ).time, '09:30');
});

test('appointment types, hours and availability', async () => {
  await owner.post('/admin/schedule/types/new', { name: 'Initial consultation', kind: 'initial', duration_min: '60', buffer_min: '15', price: '90.00', deposit: '30.00', mode: 'either', capacity: '1', online_booking: '1', active: '1', staff_ids: [String(ids.ann), String(ids.ben)] }, '/admin/schedule/types');
  ids.type = (await get("SELECT id FROM appointment_types WHERE name = 'Initial consultation'")).id;
  await owner.post('/admin/schedule/types/new', { name: 'Herb walk', kind: 'workshop', duration_min: '60', price: '20.00', mode: 'in_person', capacity: '3', online_booking: '1', active: '1', staff_ids: String(ids.ann) }, '/admin/schedule/types');
  ids.group = (await get("SELECT id FROM appointment_types WHERE name = 'Herb walk'")).id;
  // Ann works Mondays 09:00–12:00; she sets her own hours and turns on online booking.
  await ann.post('/admin/schedule/hours', { staff_id: ids.ann, d1_0_start: '09:00', d1_0_end: '12:00' }, '/admin/schedule/hours');
  await ann.post('/admin/schedule/profile', { staff_id: ids.ann, display_name: 'Ann R.', title: 'Clinical herbalist', accepts_bookings: '1', public_profile: '1', new_calendar_token: '1' }, '/admin/schedule/hours');
  // She can't edit Ben's.
  await ann.post('/admin/schedule/hours', { staff_id: ids.ben, d1_0_start: '09:00', d1_0_end: '17:00' }, '/admin/schedule/hours');
  assert.equal(await get('SELECT 1 FROM practitioner_hours WHERE staff_id = ?', ids.ben), undefined);
  ids.monday = nextWeekday(1);
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', ids.type);
  const slots = await scheduling.slots(type, ids.ann, ids.monday, ids.monday);
  assert.deepEqual(slots.map((s) => s.time), ['09:00', '09:30', '10:00', '10:30', '11:00'], '60 min fits up to 11:00 in a 09–12 window');
  const page = await new Client(ctx.base).get(`/book/${ids.type}?staff=${ids.ann}&from=${ids.monday}`);
  assert.match(page.text, /09:00/);
  assert.match((await new Client(ctx.base).get('/book')).text, /Clinical herbalist/);
});

test('online booking: log in, book, invoice with deposit, confirmation email, conflict-safe', async () => {
  client = new Client(ctx.base);
  await client.post('/account/register', { first_name: 'Lee', last_name: 'Moss', email: 'lee@example.com', password: 'password123' }, '/account/register');
  const startAt = scheduling.zonedToUtc(ids.monday, '10:00', TZ).toISOString();
  const res = await client.post(`/book/${ids.type}`, { staff_id: ids.ann, start: startAt, mode: 'virtual' }, `/book/${ids.type}`);
  assert.equal(res.location, '/account/appointments');
  const a = await get('SELECT * FROM appointments WHERE customer_id = (SELECT id FROM customers WHERE email = ?)', 'lee@example.com');
  ids.appt = a.id;
  assert.equal(new Date(a.starts_at).toISOString(), startAt);
  assert.equal(a.mode, 'virtual');
  const inv = await get('SELECT * FROM invoices WHERE appointment_id = ?', a.id);
  assert.equal(inv.total, 9000);
  assert.equal(inv.status, 'open');
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'lee@example.com' AND subject LIKE 'Booking confirmed%'");
  assert.ok(mail);
  // 10:00 is taken; with a 15-minute buffer 09:00 (ends 10:00) is blocked too, and 11:00 is blocked (10:00 + 60 + 15 > 11:00).
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', ids.type);
  const slots = (await scheduling.slots(type, ids.ann, ids.monday, ids.monday)).map((s) => s.time);
  assert.deepEqual(slots, []);
  // Booking the same time again is refused.
  const other = new Client(ctx.base);
  await other.post('/account/register', { first_name: 'Kim', last_name: 'Ash', email: 'kim@example.com', password: 'password123' }, '/account/register');
  await other.post(`/book/${ids.type}`, { staff_id: ids.ann, start: startAt }, `/book/${ids.type}`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM appointments WHERE starts_at = ?', startAt)).n, 1);
  // Bookings need an account: a guest is sent to log in, and the slot waits for them.
  const guest = new Client(ctx.base);
  const g = await guest.post(`/book/${ids.type}`, { staff_id: ids.ann, start: scheduling.zonedToUtc(ids.monday, '09:00', TZ).toISOString() }, `/book/${ids.type}`);
  assert.match(g.location, /\/account\/login\?next=.*confirm/);
  assert.match((await client.get('/account/appointments')).text, /Initial consultation/);
  assert.match((await client.get(`/account/appointments/${ids.appt}.ics`)).text, /BEGIN:VEVENT/);
});

test('group sessions take several people up to capacity', async () => {
  const startAt = scheduling.zonedToUtc(scheduling.addDays(ids.monday, 7), '09:00', TZ).toISOString();
  const people = [];
  for (const n of [1, 2, 3, 4]) {
    const c = new Client(ctx.base);
    await c.post('/account/register', { first_name: `G${n}`, last_name: 'Walker', email: `g${n}@example.com`, password: 'password123' }, '/account/register');
    people.push(c);
  }
  for (const c of people) await c.post(`/book/${ids.group}`, { staff_id: ids.ann, start: startAt }, `/book/${ids.group}`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM appointments WHERE type_id = ? AND starts_at = ?', ids.group, startAt)).n, 3, 'capacity 3: the fourth is refused');
});

test('cancellation window, rescheduling and the waitlist', async () => {
  const kim = new Client(ctx.base);
  await kim.post('/account/login', { email: 'kim@example.com', password: 'password123' }, '/account/login');
  await kim.post(`/book/${ids.type}/waitlist`, { staff_id: ids.ann, preferences: 'Mondays' }, `/book/${ids.type}`);
  assert.ok(await get('SELECT 1 FROM appointment_waitlist WHERE status = ?', 'waiting'));
  // Lee moves to the following Monday 09:00... which the group walk now occupies, so 10:00 instead.
  const newStart = scheduling.zonedToUtc(scheduling.addDays(ids.monday, 7), '11:00', TZ).toISOString();
  let res = await client.post(`/account/appointments/${ids.appt}/reschedule`, { start: newStart }, `/account/appointments/${ids.appt}/reschedule`);
  assert.equal(res.location, '/account/appointments');
  assert.equal(new Date((await get('SELECT starts_at FROM appointments WHERE id = ?', ids.appt)).starts_at).toISOString(), newStart);
  assert.ok(await get('SELECT 1 FROM invoices WHERE appointment_id = ?', ids.appt), 'the invoice stays with the appointment');
  const waitMail = await get("SELECT * FROM email_outbox WHERE to_address = 'kim@example.com' AND subject LIKE '%opened up%'");
  assert.ok(waitMail, 'the freed slot was offered to the waitlist');
  // Inside the cancellation window, online cancelling is refused.
  await run("UPDATE appointments SET starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours' WHERE id = ?", ids.appt);
  await client.post(`/account/appointments/${ids.appt}/cancel`, {}, '/account/appointments');
  assert.equal((await get('SELECT status FROM appointments WHERE id = ?', ids.appt)).status, 'booked');
  await run("UPDATE appointments SET starts_at = now() + interval '5 days', ends_at = now() + interval '5 days 1 hour' WHERE id = ?", ids.appt);
  await client.post(`/account/appointments/${ids.appt}/cancel`, {}, '/account/appointments');
  assert.equal((await get('SELECT status FROM appointments WHERE id = ?', ids.appt)).status, 'cancelled');
});

test('staff booking: recurring series, override, notes encrypted, practitioners see only their own calendar', async () => {
  const lee = await get("SELECT id FROM customers WHERE email = 'lee@example.com'");
  const day = scheduling.addDays(ids.monday, 14);
  let res = await ann.post('/admin/schedule/appointments/new', { type_id: ids.type, customer_id: lee.id, day, time: '09:00', mode: 'in_person', repeat_weeks: '3', notes: 'Discuss sleep diary', invoice: '1' }, '/admin/schedule/appointments/new');
  assert.match(res.location, /appointments\/\d+$/);
  const series = await all('SELECT * FROM appointments WHERE series_id IS NOT NULL ORDER BY starts_at');
  assert.equal(series.length, 3);
  assert.ok(series.every((s) => s.staff_id === ids.ann));
  assert.doesNotMatch(series[0].notes_enc, /sleep diary/);
  assert.equal((await all('SELECT id FROM invoices WHERE appointment_id = ANY(?::int[])', `{${series.map((s) => s.id).join(',')}}`)).length, 3);
  // Outside hours needs an override.
  res = await owner.post('/admin/schedule/appointments/new', { type_id: ids.type, staff_id: ids.ben, customer_id: lee.id, day, time: '18:00' }, '/admin/schedule/appointments/new');
  assert.equal(res.location, '/admin/schedule/appointments/new');
  res = await owner.post('/admin/schedule/appointments/new', { type_id: ids.type, staff_id: ids.ben, customer_id: lee.id, day, time: '18:00', override: '1' }, '/admin/schedule/appointments/new');
  ids.benAppt = Number(res.location.split('/').pop());
  assert.equal((await ann.get(`/admin/schedule/appointments/${ids.benAppt}`)).status, 404, "Ann can't open Ben's appointments");
  assert.equal((await ann.get(`/admin/schedule/appointments/${series[0].id}`)).status, 200);
  assert.equal((await ann.get('/admin/schedule/types')).status, 403);
  assert.match((await owner.get(`/admin/schedule?week=${day}`)).text, /Ben Herbalist/);
});

test('the practitioner calendar feed never contains client names', async () => {
  const pp = await get('SELECT calendar_token FROM practitioner_profiles WHERE staff_id = ?', ids.ann);
  const feed = await new Client(ctx.base).get(`/calendar/${pp.calendar_token}.ics`);
  assert.equal(feed.status, 200);
  assert.match(feed.text, /SUMMARY:Initial consultation/);
  assert.doesNotMatch(feed.text, /Lee|Moss|lee@example\.com|sleep/i);
  assert.equal((await new Client(ctx.base).get('/calendar/not-a-token.ics')).status, 404);
});

test('invoices: payments, overpayment refused, public link; ledger and financial report', async () => {
  const inv = await get('SELECT * FROM invoices ORDER BY id LIMIT 1');
  const page = `/admin/invoices/${inv.id}`;
  await owner.post(`${page}/payments`, { amount: '100.00', method: 'Cash' }, page);
  assert.equal((await get('SELECT paid_total FROM invoices WHERE id = ?', inv.id)).paid_total, 0, 'more than owed is refused');
  await owner.post(`${page}/payments`, { amount: '30.00', method: 'Card' }, page);
  assert.equal((await get('SELECT status FROM invoices WHERE id = ?', inv.id)).status, 'partial');
  await owner.post(`${page}/payments`, { amount: '60.00', method: 'Card' }, page);
  assert.equal((await get('SELECT status FROM invoices WHERE id = ?', inv.id)).status, 'paid');
  const pub = await new Client(ctx.base).get(`/invoices/${inv.token}`);
  assert.match(pub.text, /Paid in full/);
  // Manual invoice and an expense.
  await owner.post('/admin/invoices/new', { email: 'walkin@example.com', first_name: 'Walk', 'items[0][description]': 'Herbal consultation', 'items[0][quantity]': '1', 'items[0][unit_price]': '50.00' }, '/admin/invoices/new');
  await owner.post('/admin/finance/expenses', { spent_on: new Date().toISOString().slice(0, 10), category: 'rent', vendor: 'Landlord', description: 'Clinic room', amount: '400.00' }, '/admin/finance/expenses');
  // Order payments land in the ledger.
  const orders = require('../src/orders');
  const o = await get("SELECT id, total FROM orders WHERE financial_status = 'pending' AND status != 'cancelled' LIMIT 1");
  const before = (await get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', o.id)).n;
  await orders.markPaid(o.id, { author: 'test' });
  assert.equal((await get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', o.id)).n, before + 1);
  await orders.refund(o.id, { amount: 100, author: 'test' });
  assert.ok(await get("SELECT 1 FROM payments WHERE order_id = ? AND kind = 'refund' AND amount = -100", o.id));
  const year = new Date().getUTCFullYear();
  const report = await owner.get(`/admin/finance?year=${year}`);
  assert.equal(report.status, 200);
  assert.match(report.text, /\$90\.00/);
  assert.match(report.text, /\$400\.00/);
  for (const kind of ['summary', 'payments', 'invoices', 'expenses']) {
    const csv = await owner.get(`/admin/finance/export/${kind}.csv?year=${year}`);
    assert.equal(csv.status, 200, kind);
  }
  const billing = require('../src/billing');
  const s = await billing.summary(`${year}-01-01`, `${year + 1}-01-01`);
  assert.equal(s.totals.services, 9000);
  assert.equal(s.totals.expenses, 40000);
  assert.equal((await ann.get('/admin/finance')).status, 403, 'practitioners do not see financials by default');
});

test('admin screens render', async () => {
  const appt = await get('SELECT id FROM appointments LIMIT 1');
  const inv = await get('SELECT id FROM invoices LIMIT 1');
  for (const url of ['/admin/schedule', '/admin/schedule/appointments/new', `/admin/schedule/appointments/${appt.id}`, '/admin/schedule/types', '/admin/schedule/types/new', `/admin/schedule/types/${ids.type}`, '/admin/schedule/hours',
    '/admin/invoices', '/admin/invoices/new', `/admin/invoices/${inv.id}`, `/admin/invoices/${inv.id}/print`, '/admin/finance', '/admin/finance/expenses']) {
    assert.equal((await owner.get(url)).status, 200, url);
  }
});
