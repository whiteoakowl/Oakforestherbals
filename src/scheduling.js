'use strict';
// Appointment scheduling. Practitioner hours are wall-clock times in the clinic's time zone
// (Settings → Booking); appointments are stored as UTC instants. Slots come from those hours minus
// time off and existing appointments, with booking notice, lookahead, buffers and group capacity.
const crypto = require('node:crypto');
const { get, all, run, insert, tx } = require('./db');
const settings = require('./settings');

const err = (message, status = 409) => Object.assign(new Error(message), { status });
const booking = () => settings.load('booking');

/* ---------- Time zones (no library: Intl does the work) ---------- */

// Offset (ms) of a zone at a given instant: local wall time minus UTC.
function zoneOffset(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

// "2026-03-08" + "09:30" in a zone -> Date (UTC instant). Handles DST changes.
function zonedToUtc(day, time, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - zoneOffset(new Date(guess), timeZone);
  return new Date(guess - zoneOffset(new Date(first), timeZone));
}

// Date -> { day: 'YYYY-MM-DD', time: 'HH:MM', weekday } in a zone.
function utcToZoned(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}

function formatWhen(date, timeZone = booking().timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(date));
}

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));

/* ---------- Availability ---------- */

async function staffForType(typeId) {
  return all(`SELECT s.id, s.name, pp.display_name, pp.title, pp.photo_url, pp.bio FROM appointment_type_staff ts JOIN staff s ON s.id = ts.staff_id
    LEFT JOIN practitioner_profiles pp ON pp.staff_id = s.id WHERE ts.type_id = ? ORDER BY s.name`, typeId);
}

/**
 * Open slots for an appointment type and practitioner between two local days (inclusive).
 * Returns [{ start: Date, end: Date, day, time, spots }]. ignoreAppointmentId lets a reschedule
 * see its own current time as free.
 */
async function slots(type, staffId, fromDay, toDay, { ignoreAppointmentId = 0, staffBooking = false } = {}) {
  const b = booking();
  const tz = b.timezone;
  const now = Date.now();
  const earliest = staffBooking ? now : now + Number(b.min_notice_hours) * 3600000;
  const latest = now + Number(b.max_days_ahead) * 86400000;
  const step = Math.max(5, Number(b.slot_step_min) || 15) * 60000;
  const dur = type.duration_min * 60000;
  const buffer = (type.buffer_min || 0) * 60000;
  const hours = await all('SELECT * FROM practitioner_hours WHERE staff_id = ?', staffId);
  const off = await all('SELECT starts_on, ends_on FROM practitioner_time_off WHERE staff_id = ? AND ends_on >= ? AND starts_on <= ?', staffId, fromDay, toDay);
  const offDays = (day) => off.some((o) => { const s = String(o.starts_on instanceof Date ? o.starts_on.toISOString() : o.starts_on).slice(0, 10); const e = String(o.ends_on instanceof Date ? o.ends_on.toISOString() : o.ends_on).slice(0, 10); return day >= s && day <= e; });
  const rangeStart = zonedToUtc(fromDay, '00:00', tz);
  const rangeEnd = zonedToUtc(addDays(toDay, 1), '00:00', tz);
  const busy = await all(`SELECT id, type_id, starts_at, ends_at FROM appointments WHERE staff_id = ? AND status IN ('booked', 'confirmed') AND id != ?
    AND starts_at < ? AND ends_at > ?`, staffId, ignoreAppointmentId, rangeEnd.toISOString(), new Date(rangeStart.getTime() - 86400000).toISOString());
  // Types that need a room only offer times when some room is free (a group session shares its room).
  const rooms = type.needs_room ? await all('SELECT id FROM rooms WHERE active = 1') : [];
  const roomBusy = rooms.length ? await all(`SELECT room_id, type_id, staff_id, starts_at, ends_at FROM appointments WHERE room_id IS NOT NULL AND status IN ('booked', 'confirmed') AND id != ?
    AND starts_at < ? AND ends_at > ?`, ignoreAppointmentId, rangeEnd.toISOString(), new Date(rangeStart.getTime() - 86400000).toISOString()) : [];
  const roomFree = (t, end) => !rooms.length || rooms.some((r) => !roomBusy.some((a) => a.room_id === r.id
    && !(type.capacity > 1 && a.staff_id === staffId && a.type_id === type.id && new Date(a.starts_at).getTime() === t)
    && new Date(a.starts_at).getTime() < end + buffer && new Date(a.ends_at).getTime() + buffer > t));
  const out = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    if (offDays(day)) continue;
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    for (const h of hours.filter((x) => x.weekday === weekday)) {
      const winStart = zonedToUtc(day, h.start_time, tz).getTime();
      const winEnd = zonedToUtc(day, h.end_time, tz).getTime();
      for (let t = winStart; t + dur <= winEnd; t += step) {
        if (t < earliest || t > latest) continue;
        const end = t + dur;
        // Group sessions: same type and start can take up to `capacity` people.
        const same = busy.filter((a) => a.type_id === type.id && new Date(a.starts_at).getTime() === t);
        const clash = busy.some((a) => !(a.type_id === type.id && new Date(a.starts_at).getTime() === t)
          && new Date(a.starts_at).getTime() < end + buffer && new Date(a.ends_at).getTime() + buffer > t);
        const spots = type.capacity - same.length;
        if (clash || spots <= 0 || !roomFree(t, end)) continue;
        const local = utcToZoned(new Date(t), tz);
        out.push({ start: new Date(t), end: new Date(end), day: local.day, time: local.time, spots });
      }
    }
  }
  return out.sort((a, b2) => a.start - b2.start);
}

/**
 * Books an appointment. Re-checks the slot inside a transaction under a per-practitioner lock so
 * two people can't take the same time. staffOverride lets staff book outside published hours.
 */
async function book({ type, staffId, customerId, start, mode, notes_enc = null, bookedBy = 'patient', staffOverride = false, seriesId = null, ignoreAppointmentId = 0, roomId = null }) {
  return tx(async () => {
    await get('SELECT pg_advisory_xact_lock(72100, ?)', staffId);
    if (type.needs_room || roomId) await get('SELECT pg_advisory_xact_lock(72101, 0)'); // rooms are shared by everyone
    const startDate = new Date(start);
    if (Number.isNaN(startDate.getTime())) throw err('Choose a time.', 422);
    const end = new Date(startDate.getTime() + type.duration_min * 60000);
    if (!staffOverride) {
      const local = utcToZoned(startDate, booking().timezone);
      const open = await slots(type, staffId, local.day, local.day, { ignoreAppointmentId });
      if (!open.some((s) => s.start.getTime() === startDate.getTime())) throw err('Sorry, that time is no longer available. Please choose another.');
    } else {
      const clash = await get(`SELECT 1 FROM appointments WHERE staff_id = ? AND status IN ('booked', 'confirmed') AND id != ? AND starts_at < ? AND ends_at > ?
        AND NOT (type_id = ? AND starts_at = ?)`, staffId, ignoreAppointmentId, end.toISOString(), startDate.toISOString(), type.id, startDate.toISOString());
      if (clash) throw err('That practitioner already has an appointment at that time.');
    }
    const p = customerId ? await get('SELECT id FROM patients WHERE customer_id = ?', customerId) : null;
    void p;
    const m = type.mode === 'either' ? (['in_person', 'virtual'].includes(mode) ? mode : 'in_person') : type.mode;
    const room = m === 'in_person' && (type.needs_room || roomId) ? await freeRoom(type, startDate, end, roomId, ignoreAppointmentId, staffId) : null;
    if (m === 'in_person' && type.needs_room && !room && (await get('SELECT 1 FROM rooms WHERE active = 1'))) throw err(roomId ? 'That room is taken at that time.' : 'No room is free at that time.');
    const video = m === 'virtual' ? videoLink() : '';
    return insert(`INSERT INTO appointments (type_id, type_name, staff_id, customer_id, starts_at, ends_at, status, mode, location, price, deposit, booked_by, notes_enc, series_id, room_id, video_link)
      VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, type.id, type.name, staffId, customerId, startDate.toISOString(), end.toISOString(), m,
    m === 'in_person' ? booking().location : '', type.price, type.deposit, bookedBy, notes_enc, seriesId, room, video);
  });
}

// The requested room if free, else the first free room; null if none. Same-type group sessions share.
async function freeRoom(type, start, end, wanted = null, ignoreId = 0, staffId = 0) {
  const buffer = (type.buffer_min || 0) * 60000;
  const rooms = await all(`SELECT id FROM rooms WHERE active = 1 ${wanted ? 'AND id = ?' : ''} ORDER BY position, id`, ...(wanted ? [wanted] : []));
  for (const r of rooms) {
    const clash = await get(`SELECT 1 FROM appointments WHERE room_id = ? AND status IN ('booked', 'confirmed') AND id != ? AND starts_at < ? AND ends_at > ?
      AND NOT (? > 1 AND staff_id = ? AND type_id = ? AND starts_at = ?)`, r.id, ignoreId, new Date(end.getTime() + buffer).toISOString(), new Date(start.getTime() - buffer).toISOString(), type.capacity || 1, staffId, type.id, start.toISOString());
    if (!clash) return r.id;
  }
  return null;
}

// Online appointments get a private video room link when a video service is chosen.
function videoLink() {
  if (booking().video_provider !== 'jitsi') return '';
  const name = String(settings.load('store').name || 'clinic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `https://meet.jit.si/${name}-${require('crypto').randomBytes(9).toString('hex')}`;
}

// Patients may cancel or move a booking up to `cancel_hours` before it starts.
function canChange(appt) {
  if (!['booked', 'confirmed'].includes(appt.status)) return false;
  return new Date(appt.starts_at).getTime() - Date.now() >= Number(booking().cancel_hours) * 3600000;
}

async function load(id) {
  return get(`SELECT a.*, s.name AS staff_name, c.email, c.first_name, c.last_name, c.phone, t.capacity, t.duration_min, t.buffer_min, t.mode AS type_mode, t.kind,
      (SELECT id FROM patients p WHERE p.customer_id = a.customer_id) AS patient_id
    FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN appointment_types t ON t.id = a.type_id WHERE a.id = ?`, id);
}

/* ---------- Calendar files ---------- */

const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// iCalendar text. Event titles carry the appointment type only — never health details.
function ics(events, name = 'Appointments') {
  const host = (process.env.URL || 'oakforest.local').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Oak Forest Herbals//Clinic//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(name)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:appointment-${e.id}@${host}`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(e.starts_at)}`, `DTEND:${icsDate(e.ends_at)}`,
      `SUMMARY:${icsText(e.summary)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      `STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

const newToken = () => crypto.randomBytes(24).toString('hex');

module.exports = { freeRoom, videoLink, zoneOffset, zonedToUtc, utcToZoned, formatWhen, addDays, validTime, staffForType, slots, book, canChange, load, ics, newToken, booking };
