'use strict';
// Clinic → Schedule: calendars, appointments, appointment types, practitioner hours and profiles,
// waitlist and booking settings. Practitioners with only "own" access see their own calendar.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const scheduling = require('../../scheduling');
const billing = require('../../billing');
const settings = require('../../settings');
const vault = require('../../vault');
const comms = require('../../comms');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, parseMoney, token } = require('../../utils');

const router = express.Router();
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const text = (v, max = 5000) => String(v || '').trim().slice(0, max);
const fail = (req, res, msg, to) => { flash(req, 'error', msg); return res.redirect(to); };
const KINDS = [['initial', 'Initial consultation'], ['follow_up', 'Follow-up consultation'], ['group', 'Group session'], ['workshop', 'Workshop'], ['education', 'Educational session'], ['other', 'Other']];
const STATUS = [['booked', 'Booked'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['no_show', 'No-show'], ['cancelled', 'Cancelled']];

router.use((req, res, next) => {
  const can = res.locals.can;
  if (!can('scheduling.manage') && !can('scheduling.own')) return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include the schedule.' });
  req.all = can('scheduling.manage');
  Object.assign(res.locals, { ymd, KINDS, STATUS, when: (d) => scheduling.formatWhen(d), tz: settings.load('booking').timezone, seesAllCalendars: req.all });
  next();
});

function manageAll(req, res, next) {
  if (req.all) return next();
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Only schedulers can change this.' });
}

// Which practitioners this person can see.
async function staffScope(req) {
  if (req.all) return all('SELECT s.id, s.name FROM staff s ORDER BY s.name');
  return [{ id: req.res.locals.staff.id, name: req.res.locals.staff.name }];
}

/* ---------- Calendar ---------- */

router.get('/', async (req, res) => {
  const tz = settings.load('booking').timezone;
  const todayLocal = scheduling.utcToZoned(new Date(), tz).day;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : todayLocal;
  const end = scheduling.addDays(start, 7);
  const people = await staffScope(req);
  const staffId = req.all ? toInt(req.query.staff) : res.locals.staff.id;
  const ids = staffId ? [staffId] : people.map((p) => p.id);
  const appts = ids.length ? await all(`SELECT a.*, s.name AS staff_name, c.first_name, c.last_name, c.email FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.staff_id = ANY(?::int[]) AND a.starts_at >= ? AND a.starts_at < ? ${req.query.cancelled === '1' ? '' : "AND a.status != 'cancelled'"} ORDER BY a.starts_at`,
  `{${ids.join(',')}}`, scheduling.zonedToUtc(start, '00:00', tz).toISOString(), scheduling.zonedToUtc(end, '00:00', tz).toISOString()) : [];
  const days = [];
  for (let d = start; d < end; d = scheduling.addDays(d, 1)) days.push({ day: d, items: appts.filter((a) => scheduling.utcToZoned(new Date(a.starts_at), tz).day === d) });
  const waitlist = await all(`SELECT w.*, t.name AS type_name, c.first_name, c.last_name, c.email FROM appointment_waitlist w JOIN appointment_types t ON t.id = w.type_id JOIN customers c ON c.id = w.customer_id
    WHERE w.status = 'waiting' ${req.all ? '' : 'AND (w.staff_id IS NULL OR w.staff_id = ?)'} ORDER BY w.id`, ...(req.all ? [] : [res.locals.staff.id]));
  res.render('admin/schedule/index', { title: 'Schedule', days, start, prev: scheduling.addDays(start, -7), next: end, people, staffId, waitlist, todayLocal, localTime: (d) => scheduling.utcToZoned(new Date(d), tz).time });
});

/* ---------- Appointments ---------- */

router.get('/appointments/new', async (req, res) => {
  const types = await all('SELECT * FROM appointment_types WHERE active = 1 ORDER BY position, name');
  const pre = { customer: toInt(req.query.customer), patient: toInt(req.query.patient) };
  if (pre.patient) {
    const p = await get('SELECT customer_id FROM patients WHERE id = ?', pre.patient);
    if (p) pre.customer = p.customer_id;
  }
  const customer = pre.customer ? await get('SELECT id, email, first_name, last_name FROM customers WHERE id = ?', pre.customer) : null;
  // Booking from a case: the appointment is filed under it (only if the case belongs to this client).
  const caseRow = customer && toInt(req.query.case) ? await get('SELECT c.id, c.title FROM clinic_cases c JOIN patients p ON p.id = c.patient_id WHERE c.id = ? AND p.customer_id = ?', toInt(req.query.case), customer.id) : null;
  res.render('admin/schedule/new', { title: 'New appointment', types, people: await staffScope(req), customer, caseRow, staffId: req.all ? 0 : res.locals.staff.id });
});

// Messages to clients carry the appointment type, time, place and practitioner — nothing clinical.
async function appointmentEmail(appt, key) {
  if (!appt || !appt.email) return;
  const store = settings.load('store');
  const who = await get('SELECT email, first_name, phone, sms_opt_in, email_reminders FROM customers WHERE id = ?', appt.customer_id);
  await comms.send(key, who || appt, {
    type: appt.type_name, practitioner: appt.staff_name, when: scheduling.formatWhen(appt.starts_at),
    where: appt.mode === 'virtual' ? `Online${appt.video_link ? `: ${appt.video_link}` : ' — your link will be sent before the appointment'}` : (appt.location || store.address || ''),
    note: settings.load('booking').confirmation_note, link: `${comms.base()}/account/appointments`, book_link: `${comms.base()}/book/${appt.type_id}`,
  }, { reminder: key === 'appointment_reminder' });
}

router.post('/appointments/new', async (req, res) => {
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', toInt(req.body.type_id));
  const staffId = req.all ? toInt(req.body.staff_id) : res.locals.staff.id;
  const back = '/admin/schedule/appointments/new';
  if (!type || !staffId) return fail(req, res, 'Choose an appointment type and practitioner.', back);
  let customer = toInt(req.body.customer_id) ? await get('SELECT * FROM customers WHERE id = ?', toInt(req.body.customer_id)) : null;
  const email = text(req.body.email, 200).toLowerCase();
  if (!customer && email.includes('@')) {
    customer = await get('SELECT * FROM customers WHERE email = ?', email);
    if (!customer) customer = { id: await insert('INSERT INTO customers (email, first_name, last_name, phone) VALUES (?, ?, ?, ?)', email, text(req.body.first_name, 100), text(req.body.last_name, 100), text(req.body.phone, 40)) };
  }
  if (!customer) return fail(req, res, 'Choose the client, or enter their email.', back);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.day || '') || !scheduling.validTime(req.body.time)) return fail(req, res, 'Choose a date and time.', back);
  const tz = settings.load('booking').timezone;
  const repeats = Math.max(1, Math.min(26, toInt(req.body.repeat_weeks, 1)));
  const seriesId = repeats > 1 ? token(8) : null;
  const notes = text(req.body.notes);
  const created = [];
  try {
    for (let w = 0; w < repeats; w++) {
      const start = scheduling.zonedToUtc(scheduling.addDays(req.body.day, w * 7), req.body.time, tz);
      created.push(await scheduling.book({ type, staffId, customerId: customer.id, start, mode: req.body.mode, notes_enc: notes ? vault.seal(notes) : null, bookedBy: 'staff', staffOverride: req.body.override === '1', seriesId }));
    }
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', `${created.length ? `${created.length} appointment(s) were booked; then: ` : ''}${e.message}`);
    return res.redirect(created.length ? `/admin/schedule/appointments/${created[0]}` : back);
  }
  const caseId = toInt(req.body.case_id) && (await get('SELECT c.id FROM clinic_cases c JOIN patients p ON p.id = c.patient_id WHERE c.id = ? AND p.customer_id = ?', toInt(req.body.case_id), customer.id) || {}).id;
  if (caseId) for (const id of created) await run('UPDATE appointments SET case_id = ? WHERE id = ?', caseId, id);
  for (const id of created) {
    if (type.price > 0 && req.body.invoice === '1') {
      const a = await scheduling.load(id);
      await billing.createInvoice({ customerId: customer.id, email: a.email, name: `${a.first_name || ''} ${a.last_name || ''}`.trim(), items: [{ description: `${type.name} — ${scheduling.formatWhen(a.starts_at)}`, quantity: 1, unit_price: type.price }], appointmentId: id, staffId, createdBy: res.locals.staff.name });
    }
  }
  if (req.body.notify === '1') await appointmentEmail(await scheduling.load(created[0]), 'appointment_confirmation');
  await audit.record(req, 'appointment.created', { entityType: 'appointment', entityId: created[0], details: { count: created.length } });
  flash(req, 'success', created.length > 1 ? `${created.length} weekly appointments booked.` : 'Appointment booked.');
  res.redirect(`/admin/schedule/appointments/${created[0]}`);
});

async function apptParam(req, res, next) {
  const a = await scheduling.load(toInt(req.params.id));
  if (!a || (!req.all && a.staff_id !== res.locals.staff.id)) return res.status(404).render('admin/error', { title: 'Not found', message: 'This appointment does not exist.' });
  a.notes = a.notes_enc ? vault.open(a.notes_enc) : '';
  req.appt = a;
  next();
}

router.get('/appointments/:id', apptParam, async (req, res) => {
  const a = req.appt;
  const invoice = a.invoice_id ? await billing.loadInvoice('id', a.invoice_id) : null;
  const local = scheduling.utcToZoned(new Date(a.starts_at), settings.load('booking').timezone);
  const series = a.series_id ? await all("SELECT id, starts_at, status FROM appointments WHERE series_id = ? ORDER BY starts_at", a.series_id) : [];
  await audit.record(req, 'appointment.viewed', { entityType: 'appointment', entityId: a.id });
  res.render('admin/schedule/appointment', { title: a.type_name, a, invoice, local, series, people: await staffScope(req) });
});

router.post('/appointments/:id', apptParam, async (req, res) => {
  const a = req.appt;
  const back = `/admin/schedule/appointments/${a.id}`;
  const status = STATUS.some(([k]) => k === req.body.status) ? req.body.status : a.status;
  const videoLink = /^https:\/\//.test(text(req.body.video_link, 500)) ? text(req.body.video_link, 500) : '';
  const notes = text(req.body.notes, 20000);
  await run('UPDATE appointments SET status = ?, video_link = ?, location = ?, notes_enc = ?, cancel_reason = ? WHERE id = ?', status, videoLink, text(req.body.location, 300), notes ? vault.seal(notes) : null,
    status === 'cancelled' ? text(req.body.cancel_reason, 300) || a.cancel_reason : a.cancel_reason, a.id);
  await audit.record(req, 'appointment.updated', { entityType: 'appointment', entityId: a.id, details: { status } });
  if (status === 'cancelled' && a.status !== 'cancelled') {
    if (req.body.notify === '1') await appointmentEmail(a, 'appointment_cancelled');
    await notifyWaitlist(a);
  } else if (status === 'confirmed' && a.status !== 'confirmed' && req.body.notify === '1') {
    await appointmentEmail({ ...a, video_link: videoLink }, 'appointment_confirmation');
  }
  flash(req, 'success', 'Appointment saved.');
  res.redirect(back);
});

router.post('/appointments/:id/reschedule', apptParam, async (req, res) => {
  const a = req.appt;
  const back = `/admin/schedule/appointments/${a.id}`;
  const type = await get('SELECT * FROM appointment_types WHERE id = ?', a.type_id);
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.day || '') || !scheduling.validTime(req.body.time)) return fail(req, res, 'Choose a new date and time.', back);
  const staffId = req.all ? toInt(req.body.staff_id) || a.staff_id : a.staff_id;
  const start = scheduling.zonedToUtc(req.body.day, req.body.time, settings.load('booking').timezone);
  try {
    await tx(async () => {
      const id = await scheduling.book({ type, staffId, customerId: a.customer_id, start, mode: a.mode, notes_enc: a.notes_enc, bookedBy: 'staff', staffOverride: req.body.override === '1', ignoreAppointmentId: a.id });
      // Keep the original row (and its invoice) — move it to the new time, drop the temporary row.
      const fresh = await get('SELECT starts_at, ends_at FROM appointments WHERE id = ?', id);
      await run('DELETE FROM appointments WHERE id = ?', id);
      await run("UPDATE appointments SET starts_at = ?, ends_at = ?, staff_id = ?, status = 'booked', reminder_sent_at = NULL WHERE id = ?", fresh.starts_at, fresh.ends_at, staffId, a.id);
    });
  } catch (e) {
    if (!e.status) throw e;
    return fail(req, res, e.message, back);
  }
  if (req.body.notify === '1') await appointmentEmail(await scheduling.load(a.id), 'appointment_moved');
  await audit.record(req, 'appointment.rescheduled', { entityType: 'appointment', entityId: a.id });
  flash(req, 'success', 'Appointment moved.');
  res.redirect(back);
});

router.post('/appointments/:id/invoice', apptParam, async (req, res) => {
  const a = req.appt;
  if (a.invoice_id) return res.redirect(`/admin/invoices/${a.invoice_id}`);
  if (!res.locals.can('invoices.manage')) return fail(req, res, 'Creating invoices needs the invoices permission.', `/admin/schedule/appointments/${a.id}`);
  const id = await billing.createInvoice({ customerId: a.customer_id, email: a.email, name: `${a.first_name || ''} ${a.last_name || ''}`.trim(), items: [{ description: `${a.type_name} — ${scheduling.formatWhen(a.starts_at)}`, quantity: 1, unit_price: a.price }], appointmentId: a.id, staffId: a.staff_id, createdBy: res.locals.staff.name });
  res.redirect(`/admin/invoices/${id}`);
});

// When a slot frees up, everyone waiting for that type (and practitioner) is told — first come, first served.
async function notifyWaitlist(a) {
  const waiting = await all(`SELECT w.id, c.email, c.first_name, c.phone, c.sms_opt_in FROM appointment_waitlist w JOIN customers c ON c.id = w.customer_id
    WHERE w.status = 'waiting' AND w.type_id = ? AND (w.staff_id IS NULL OR w.staff_id = ?)`, a.type_id, a.staff_id);
  for (const w of waiting) {
    await comms.send('waitlist_opening', w, { type: a.type_name, when: scheduling.formatWhen(a.starts_at), book_link: `${comms.base()}/book/${a.type_id}` });
    await run('UPDATE appointment_waitlist SET notified_at = now() WHERE id = ?', w.id);
  }
}

router.post('/waitlist/:id/remove', manageAll, async (req, res) => {
  await run("UPDATE appointment_waitlist SET status = 'removed' WHERE id = ?", toInt(req.params.id));
  res.redirect('/admin/schedule');
});

/* ---------- Appointment types ---------- */

router.get('/types', manageAll, async (req, res) => {
  const types = await all('SELECT t.*, (SELECT string_agg(s.name, \', \') FROM appointment_type_staff ts JOIN staff s ON s.id = ts.staff_id WHERE ts.type_id = t.id) AS staff_names FROM appointment_types t ORDER BY position, name');
  res.render('admin/schedule/types', { title: 'Appointment types', types });
});

router.get('/types/:id', manageAll, async (req, res) => {
  const id = req.params.id === 'new' ? 0 : toInt(req.params.id);
  const type = id ? await get('SELECT * FROM appointment_types WHERE id = ?', id) : null;
  const staffIds = id ? (await all('SELECT staff_id FROM appointment_type_staff WHERE type_id = ?', id)).map((r) => r.staff_id) : [];
  res.render('admin/schedule/type', { title: type ? type.name : 'New appointment type', type, staffIds, people: await all('SELECT id, name FROM staff ORDER BY name') });
});

router.post('/types/:id', manageAll, async (req, res) => {
  const b = req.body;
  const name = text(b.name, 200);
  const back = `/admin/schedule/types/${req.params.id}`;
  if (!name) return fail(req, res, 'Give the appointment type a name.', back);
  const cols = [name, text(b.description, 2000), KINDS.some(([k]) => k === b.kind) ? b.kind : 'other', Math.max(5, toInt(b.duration_min, 60)), Math.max(0, toInt(b.buffer_min, 0)),
    parseMoney(b.price) || 0, parseMoney(b.deposit) || 0, ['in_person', 'virtual', 'either'].includes(b.mode) ? b.mode : 'either', Math.max(1, toInt(b.capacity, 1)), b.online_booking === '1' ? 1 : 0, b.active === '0' ? 0 : 1];
  const id = await tx(async () => {
    let tid = req.params.id === 'new' ? 0 : toInt(req.params.id);
    if (tid) await run('UPDATE appointment_types SET name = ?, description = ?, kind = ?, duration_min = ?, buffer_min = ?, price = ?, deposit = ?, mode = ?, capacity = ?, online_booking = ?, active = ? WHERE id = ?', ...cols, tid);
    else tid = await insert('INSERT INTO appointment_types (name, description, kind, duration_min, buffer_min, price, deposit, mode, capacity, online_booking, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...cols);
    await run('DELETE FROM appointment_type_staff WHERE type_id = ?', tid);
    for (const s of [].concat(b.staff_ids || []).map(toInt).filter(Boolean)) await run('INSERT INTO appointment_type_staff (type_id, staff_id) VALUES (?, ?) ON CONFLICT DO NOTHING', tid, s);
    return tid;
  });
  flash(req, 'success', 'Appointment type saved.');
  res.redirect(`/admin/schedule/types/${id}`);
});

/* ---------- Hours, time off and practitioner profile ---------- */

router.get('/hours', async (req, res) => {
  const people = await staffScope(req);
  const staffId = req.all ? toInt(req.query.staff) || (people[0] && people[0].id) : res.locals.staff.id;
  const hours = await all('SELECT * FROM practitioner_hours WHERE staff_id = ? ORDER BY weekday, start_time', staffId);
  const timeOff = await all('SELECT * FROM practitioner_time_off WHERE staff_id = ? AND ends_on >= CURRENT_DATE ORDER BY starts_on', staffId);
  const profile = (await get('SELECT * FROM practitioner_profiles WHERE staff_id = ?', staffId)) || {};
  res.render('admin/schedule/hours', { title: 'Hours and profile', people, staffId, hours, timeOff, profile, s: settings.load('booking'), base: process.env.BASE_URL || process.env.URL || '' });
});

const canEditStaff = (req, staffId) => req.all || staffId === req.res.locals.staff.id;

router.post('/hours', async (req, res) => {
  const staffId = toInt(req.body.staff_id);
  if (!canEditStaff(req, staffId)) return fail(req, res, 'You can only change your own hours.', '/admin/schedule/hours');
  await tx(async () => {
    await run('DELETE FROM practitioner_hours WHERE staff_id = ?', staffId);
    for (let d = 0; d < 7; d++) {
      for (const slot of [0, 1]) {
        const start = req.body[`d${d}_${slot}_start`];
        const end = req.body[`d${d}_${slot}_end`];
        if (scheduling.validTime(start) && scheduling.validTime(end) && start < end) await run('INSERT INTO practitioner_hours (staff_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', staffId, d, start, end);
      }
    }
  });
  flash(req, 'success', 'Weekly hours saved.');
  res.redirect(`/admin/schedule/hours?staff=${staffId}`);
});

router.post('/time-off', async (req, res) => {
  const staffId = toInt(req.body.staff_id);
  if (!canEditStaff(req, staffId)) return fail(req, res, 'You can only change your own time off.', '/admin/schedule/hours');
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.starts_on || '') && /^\d{4}-\d{2}-\d{2}$/.test(req.body.ends_on || '') && req.body.starts_on <= req.body.ends_on) {
    await run('INSERT INTO practitioner_time_off (staff_id, starts_on, ends_on, note) VALUES (?, ?, ?, ?)', staffId, req.body.starts_on, req.body.ends_on, text(req.body.note, 200));
  } else flash(req, 'error', 'Choose the first and last day off.');
  res.redirect(`/admin/schedule/hours?staff=${staffId}`);
});

router.post('/time-off/:id/delete', async (req, res) => {
  const row = await get('SELECT * FROM practitioner_time_off WHERE id = ?', toInt(req.params.id));
  if (row && canEditStaff(req, row.staff_id)) await run('DELETE FROM practitioner_time_off WHERE id = ?', row.id);
  res.redirect(`/admin/schedule/hours?staff=${row ? row.staff_id : ''}`);
});

router.post('/profile', async (req, res) => {
  const staffId = toInt(req.body.staff_id);
  if (!canEditStaff(req, staffId)) return fail(req, res, 'You can only change your own profile.', '/admin/schedule/hours');
  const b = req.body;
  const cols = [text(b.display_name, 100), text(b.title, 100), text(b.bio, 5000), text(b.qualifications, 2000), text(b.areas, 1000), /^(https?:\/\/|\/)/.test(text(b.photo_url, 500)) ? text(b.photo_url, 500) : '', b.public_profile === '1' ? 1 : 0, b.accepts_bookings === '1' ? 1 : 0];
  await run(`INSERT INTO practitioner_profiles (staff_id, display_name, title, bio, qualifications, areas, photo_url, public_profile, accepts_bookings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (staff_id) DO UPDATE SET display_name = EXCLUDED.display_name, title = EXCLUDED.title, bio = EXCLUDED.bio, qualifications = EXCLUDED.qualifications, areas = EXCLUDED.areas,
    photo_url = EXCLUDED.photo_url, public_profile = EXCLUDED.public_profile, accepts_bookings = EXCLUDED.accepts_bookings`, staffId, ...cols);
  if (b.new_calendar_token === '1') await run('UPDATE practitioner_profiles SET calendar_token = ? WHERE staff_id = ?', scheduling.newToken(), staffId);
  flash(req, 'success', 'Profile saved.');
  res.redirect(`/admin/schedule/hours?staff=${staffId}`);
});

router.post('/settings', manageAll, async (req, res) => {
  const tz = text(req.body.timezone, 60);
  let validTz = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { validTz = false; }
  if (!validTz) return fail(req, res, 'That time zone isn’t recognised. Use a name like America/Chicago.', '/admin/schedule/hours');
  await settings.save('booking', {
    timezone: tz, min_notice_hours: Math.max(0, toInt(req.body.min_notice_hours, 12)), max_days_ahead: Math.max(1, toInt(req.body.max_days_ahead, 60)),
    cancel_hours: Math.max(0, toInt(req.body.cancel_hours, 24)), slot_step_min: Math.max(5, toInt(req.body.slot_step_min, 15)), location: text(req.body.location, 300),
    confirmation_note: text(req.body.confirmation_note, 1000), reminder_hours: Math.max(1, toInt(req.body.reminder_hours, 24)),
  });
  flash(req, 'success', 'Booking settings saved.');
  res.redirect('/admin/schedule/hours');
});

module.exports = router;
module.exports.appointmentEmail = appointmentEmail;
module.exports.notifyWaitlist = notifyWaitlist;
