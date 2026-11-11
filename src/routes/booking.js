'use strict';
// Public booking (/book), the customer's appointments (/account/appointments), invoice pages
// (/invoices/:token) and practitioners' private calendar feeds (/calendar/:token.ics).
const express = require('express');
const { get, all, run, insert } = require('../db');
const scheduling = require('../scheduling');
const billing = require('../billing');
const stripe = require('../stripe');
const settings = require('../settings');
const audit = require('../audit');
const { flash, requireCustomer } = require('../middleware');
const { toInt } = require('../utils');

const router = express.Router();
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const baseUrl = (req) => (process.env.BASE_URL || process.env.URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
router.use((req, res, next) => { Object.assign(res.locals, { ymd, when: (d) => scheduling.formatWhen(d), localTime: (d) => scheduling.utcToZoned(new Date(d), settings.load('booking').timezone).time }); next(); });

const bookableTypes = () => all(`SELECT t.* FROM appointment_types t WHERE t.active = 1 AND t.online_booking = 1
  AND EXISTS (SELECT 1 FROM appointment_type_staff ts JOIN practitioner_profiles pp ON pp.staff_id = ts.staff_id WHERE ts.type_id = t.id AND pp.accepts_bookings = 1) ORDER BY t.position, t.name`);
const bookableStaff = (typeId) => all(`SELECT s.id, COALESCE(NULLIF(pp.display_name, ''), s.name) AS name, pp.title, pp.bio, pp.photo_url, pp.qualifications, pp.areas FROM appointment_type_staff ts JOIN staff s ON s.id = ts.staff_id
  JOIN practitioner_profiles pp ON pp.staff_id = s.id WHERE ts.type_id = ? AND pp.accepts_bookings = 1 ORDER BY s.name`, typeId);

router.get('/book', async (req, res) => {
  const types = await bookableTypes();
  const practitioners = await all(`SELECT COALESCE(NULLIF(pp.display_name, ''), s.name) AS name, pp.title, pp.bio, pp.photo_url, pp.qualifications, pp.areas FROM practitioner_profiles pp
    JOIN staff s ON s.id = pp.staff_id WHERE pp.public_profile = 1 ORDER BY s.name`);
  res.render('store/book/index', { title: 'Book an appointment', types, practitioners });
});

router.get('/book/:typeId', async (req, res, next) => {
  const type = (await bookableTypes()).find((t) => t.id === toInt(req.params.typeId));
  if (!type) return next();
  const staffList = await bookableStaff(type.id);
  const staffId = toInt(req.query.staff) || (staffList[0] && staffList[0].id);
  const tz = settings.load('booking').timezone;
  const today = scheduling.utcToZoned(new Date(), tz).day;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') && req.query.from >= today ? req.query.from : today;
  const to = scheduling.addDays(from, 6);
  const open = staffId && staffList.some((s) => s.id === staffId) ? await scheduling.slots(type, staffId, from, to) : [];
  const days = [];
  for (let d = from; d <= to; d = scheduling.addDays(d, 1)) days.push({ day: d, slots: open.filter((s) => s.day === d) });
  res.render('store/book/type', { title: type.name, type, staffList, staffId, days, from, prev: from > today ? scheduling.addDays(from, -7) : null, next: scheduling.addDays(from, 7), tz });
});

router.post('/book/:typeId', async (req, res, next) => {
  const type = (await bookableTypes()).find((t) => t.id === toInt(req.params.typeId));
  if (!type) return next();
  const back = `/book/${type.id}?staff=${toInt(req.body.staff_id)}`;
  if (!res.locals.customer) {
    req.session.pendingBooking = { typeId: type.id, staffId: toInt(req.body.staff_id), start: String(req.body.start || ''), mode: req.body.mode };
    flash(req, 'success', 'Log in or create an account to finish booking — it keeps your appointments and clinic information together.');
    return res.redirect(`/account/login?next=${encodeURIComponent(`/book/${type.id}/confirm`)}`);
  }
  return finishBooking(req, res, type, { staffId: toInt(req.body.staff_id), start: String(req.body.start || ''), mode: req.body.mode }, back);
});

// After logging in, the chosen slot is waiting in the session.
router.get('/book/:typeId/confirm', requireCustomer, async (req, res) => {
  const p = req.session.pendingBooking;
  const type = (await bookableTypes()).find((t) => t.id === toInt(req.params.typeId));
  if (!p || !type || p.typeId !== type.id) return res.redirect(`/book/${toInt(req.params.typeId)}`);
  res.render('store/book/confirm', { title: 'Confirm your appointment', type, p, staff: (await bookableStaff(type.id)).find((s) => s.id === p.staffId) });
});

router.post('/book/:typeId/confirm', requireCustomer, async (req, res) => {
  const p = req.session.pendingBooking;
  const type = (await bookableTypes()).find((t) => t.id === toInt(req.params.typeId));
  if (!p || !type) return res.redirect('/book');
  delete req.session.pendingBooking;
  return finishBooking(req, res, type, p, `/book/${type.id}?staff=${p.staffId}`);
});

async function finishBooking(req, res, type, { staffId, start, mode }, back) {
  if (!(await bookableStaff(type.id)).some((s) => s.id === staffId)) { flash(req, 'error', 'Choose a practitioner.'); return res.redirect(back); }
  const customer = res.locals.customer;
  let id;
  try {
    id = await scheduling.book({ type, staffId, customerId: customer.id, start, mode, bookedBy: 'patient' });
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
    return res.redirect(back);
  }
  const a = await scheduling.load(id);
  let invoice = null;
  if (type.price > 0) {
    const invId = await billing.createInvoice({ customerId: customer.id, email: customer.email, name: `${customer.first_name} ${customer.last_name}`.trim(), items: [{ description: `${type.name} — ${scheduling.formatWhen(a.starts_at)}`, quantity: 1, unit_price: type.price }], appointmentId: id, staffId, createdBy: 'Online booking' });
    invoice = await billing.loadInvoice('id', invId);
  }
  await require('./admin/schedule').appointmentEmail(a, 'appointment_confirmation');
  await require('../comms').notifyStaff({ kind: 'booking', title: `Online booking: ${type.name}, ${scheduling.formatWhen(a.starts_at)}`, link: `/admin/schedule/appointments/${id}`, staffId });
  await audit.record(req, 'appointment.booked_online', { entityType: 'appointment', entityId: id, actor: { type: 'customer', id: customer.id, name: customer.email } });
  // A deposit is paid now through Stripe when card payments are set up; otherwise at the clinic.
  if (invoice && type.deposit > 0 && stripe.stripeConfigured()) {
    try { return res.redirect(await stripe.createInvoiceSession(invoice, Math.min(type.deposit, invoice.total), baseUrl(req))); } catch (e) { console.error('stripe deposit', e.message); }
  }
  flash(req, 'success', `Booked: ${type.name}, ${scheduling.formatWhen(a.starts_at)}.${type.deposit > 0 ? ' Your deposit can be paid from your invoice.' : ''}`);
  return res.redirect('/account/appointments');
}

router.post('/book/:typeId/waitlist', requireCustomer, async (req, res, next) => {
  const type = (await bookableTypes()).find((t) => t.id === toInt(req.params.typeId));
  if (!type) return next();
  await insert('INSERT INTO appointment_waitlist (type_id, staff_id, customer_id, preferences) VALUES (?, ?, ?, ?)', type.id, toInt(req.body.staff_id) || null, res.locals.customer.id, String(req.body.preferences || '').slice(0, 500));
  flash(req, 'success', "You're on the waitlist. We'll email you if a time opens up.");
  res.redirect(`/book/${type.id}`);
});

/* ---------- The customer's appointments ---------- */

const mine = (req, id) => get(`SELECT a.*, s.name AS staff_name FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.id = ? AND a.customer_id = ?`, id, req.res.locals.customer.id);

router.get('/account/appointments', requireCustomer, async (req, res) => {
  const rows = await all(`SELECT a.*, s.name AS staff_name, i.token AS invoice_token, i.total AS invoice_total, i.paid_total FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
    LEFT JOIN invoices i ON i.id = a.invoice_id WHERE a.customer_id = ? ORDER BY a.starts_at DESC`, res.locals.customer.id);
  const now = Date.now();
  res.render('store/book/mine', { title: 'My appointments', upcoming: rows.filter((a) => new Date(a.starts_at) > now && a.status !== 'cancelled').reverse(), past: rows.filter((a) => new Date(a.starts_at) <= now || a.status === 'cancelled'), canChange: scheduling.canChange, cancelHours: settings.load('booking').cancel_hours });
});

router.post('/account/appointments/:id/cancel', requireCustomer, async (req, res) => {
  const a = await mine(req, toInt(req.params.id));
  if (!a || !scheduling.canChange(a)) { flash(req, 'error', `Appointments can be cancelled online up to ${settings.load('booking').cancel_hours} hours before. Please contact us.`); return res.redirect('/account/appointments'); }
  await run("UPDATE appointments SET status = 'cancelled', cancel_reason = 'Cancelled by client' WHERE id = ?", a.id);
  await audit.record(req, 'appointment.cancelled_online', { entityType: 'appointment', entityId: a.id, actor: { type: 'customer', id: res.locals.customer.id, name: res.locals.customer.email } });
  await require('./admin/schedule').notifyWaitlist(a);
  flash(req, 'success', 'Appointment cancelled.');
  res.redirect('/account/appointments');
});

router.get('/account/appointments/:id/reschedule', requireCustomer, async (req, res) => {
  const a = await mine(req, toInt(req.params.id));
  if (!a || !scheduling.canChange(a)) return res.redirect('/account/appointments');
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', a.type_id);
  const tz = settings.load('booking').timezone;
  const today = scheduling.utcToZoned(new Date(), tz).day;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') && req.query.from >= today ? req.query.from : today;
  const open = await scheduling.slots(type, a.staff_id, from, scheduling.addDays(from, 6), { ignoreAppointmentId: a.id });
  const days = [];
  for (let d = from; d <= scheduling.addDays(from, 6); d = scheduling.addDays(d, 1)) days.push({ day: d, slots: open.filter((s) => s.day === d) });
  res.render('store/book/reschedule', { title: 'Choose a new time', a, days, prev: from > today ? scheduling.addDays(from, -7) : null, next: scheduling.addDays(from, 7) });
});

router.post('/account/appointments/:id/reschedule', requireCustomer, async (req, res) => {
  const a = await mine(req, toInt(req.params.id));
  if (!a || !scheduling.canChange(a)) return res.redirect('/account/appointments');
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', a.type_id);
  try {
    const tmp = await scheduling.book({ type, staffId: a.staff_id, customerId: a.customer_id, start: String(req.body.start || ''), mode: a.mode, bookedBy: 'patient', ignoreAppointmentId: a.id });
    const fresh = await get('SELECT starts_at, ends_at FROM appointments WHERE id = ?', tmp);
    await run('DELETE FROM appointments WHERE id = ?', tmp);
    await run("UPDATE appointments SET starts_at = ?, ends_at = ?, reminder_sent_at = NULL WHERE id = ?", fresh.starts_at, fresh.ends_at, a.id);
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
    return res.redirect(`/account/appointments/${a.id}/reschedule`);
  }
  await audit.record(req, 'appointment.rescheduled_online', { entityType: 'appointment', entityId: a.id, actor: { type: 'customer', id: res.locals.customer.id, name: res.locals.customer.email } });
  await require('./admin/schedule').notifyWaitlist(a);
  flash(req, 'success', 'Your appointment has been moved.');
  res.redirect('/account/appointments');
});

router.get('/account/appointments/:id.ics', requireCustomer, async (req, res) => {
  const a = await mine(req, toInt(req.params.id));
  if (!a) return res.status(404).send('Not found');
  res.type('text/calendar').attachment('appointment.ics').send(scheduling.ics([{ ...a, summary: `${a.type_name} — ${settings.load('store').name}`, location: a.mode === 'virtual' ? a.video_link || 'Online' : a.location }]));
});

/* ---------- Invoices (public link with an unguessable token) ---------- */

router.get('/invoices/:token', async (req, res, next) => {
  const inv = await billing.loadInvoice('token', String(req.params.token));
  if (!inv || inv.status === 'draft') return next();
  res.render('store/invoice', { title: `Invoice #${inv.number}`, inv, printOnly: false, canPay: inv.balance > 0 && inv.status !== 'void' && stripe.stripeConfigured() });
});

router.post('/invoices/:token/pay', async (req, res, next) => {
  const inv = await billing.loadInvoice('token', String(req.params.token));
  if (!inv || inv.balance <= 0 || !stripe.stripeConfigured()) return next();
  res.redirect(await stripe.createInvoiceSession(inv, inv.balance, baseUrl(req)));
});

router.get('/invoices/:token/stripe/return', async (req, res, next) => {
  const inv = await billing.loadInvoice('token', String(req.params.token));
  if (!inv) return next();
  const session = await stripe.retrieveSession(String(req.query.session_id || '')).catch(() => null);
  if (session && session.payment_status === 'paid' && session.client_reference_id === `invoice-${inv.token}`
    && !(await get('SELECT 1 FROM payments WHERE reference = ? AND invoice_id = ?', session.id, inv.id))) {
    await billing.recordPayment({ invoiceId: inv.id, amount: session.amount_total, method: 'Stripe', reference: session.id, by: 'Stripe' }).catch((e) => console.error('invoice payment', e.message));
    flash(req, 'success', 'Thank you — your payment was received.');
  }
  res.redirect(`/invoices/${inv.token}`);
});

/* ---------- Practitioner calendar feed (subscribe from Google/Apple/Outlook) ---------- */

router.get('/calendar/:token.ics', async (req, res, next) => {
  const pp = await get('SELECT * FROM practitioner_profiles WHERE calendar_token = ?', String(req.params.token));
  if (!pp || !pp.calendar_token) return next();
  const rows = await all("SELECT id, type_name, starts_at, ends_at, status, mode, location FROM appointments WHERE staff_id = ? AND starts_at > now() - interval '30 days' ORDER BY starts_at", pp.staff_id);
  // No names or health details leave the system: events say only what kind of appointment it is.
  res.type('text/calendar').set('Cache-Control', 'private, max-age=300').send(scheduling.ics(rows.map((a) => ({ ...a, summary: a.type_name, location: a.mode === 'virtual' ? 'Online' : a.location, description: 'Open the clinic admin for details.' })), `${settings.load('store').name} appointments`));
});

module.exports = router;
