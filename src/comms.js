'use strict';
// Customer messages (email and SMS) from editable templates, and in-app notifications for staff.
// Privacy rule: templates only ever receive non-clinical values (names, times, places, links).
// Clinical content stays in the portal behind a login.
const { get, all, run, insert } = require('./db');
const mailer = require('./mailer');
const settings = require('./settings');

const base = () => (process.env.BASE_URL || process.env.URL || '').replace(/\/$/, '');

// [key, label, subject, body (HTML), sms, placeholders]
const TEMPLATES = [
  ['appointment_confirmation', 'Appointment booked', 'Booking confirmed — {{store}}',
    '<p>Hi {{first_name}},</p><p>You\'re booked in for <strong>{{type}}</strong> with {{practitioner}} on <strong>{{when}}</strong>.</p><p>{{where}}</p><p>{{note}}</p><p><a href="{{link}}">See or change your appointments</a></p>',
    '{{store}}: {{type}} booked for {{when}}. Manage: {{link}}', 'first_name, type, practitioner, when, where, note, link, store'],
  ['appointment_reminder', 'Appointment reminder', 'Reminder: your appointment {{when}}',
    '<p>Hi {{first_name}},</p><p>This is a reminder of your <strong>{{type}}</strong> with {{practitioner}} on <strong>{{when}}</strong>.</p><p>{{where}}</p><p><a href="{{link}}">Need to change it?</a></p>',
    'Reminder from {{store}}: {{type}} {{when}}. {{where}} Manage: {{link}}', 'first_name, type, practitioner, when, where, link, store'],
  ['appointment_moved', 'Appointment moved', 'Appointment moved — {{store}}',
    '<p>Hi {{first_name}},</p><p>Your <strong>{{type}}</strong> is now on <strong>{{when}}</strong> with {{practitioner}}.</p><p>{{where}}</p><p><a href="{{link}}">See your appointments</a></p>',
    '{{store}}: your {{type}} moved to {{when}}.', 'first_name, type, practitioner, when, where, link, store'],
  ['appointment_cancelled', 'Appointment cancelled', 'Appointment cancelled — {{store}}',
    '<p>Hi {{first_name}},</p><p>Your <strong>{{type}}</strong> on {{when}} has been cancelled.</p><p><a href="{{book_link}}">Book another time</a></p>',
    '{{store}}: your {{type}} on {{when}} was cancelled.', 'first_name, type, when, book_link, store'],
  ['waitlist_opening', 'Waitlist: slot opened', 'A {{type}} time opened up',
    '<p>A time you were waiting for is available: <strong>{{when}}</strong>.</p><p><a href="{{book_link}}">Book it before someone else does</a></p>', '{{store}}: a {{type}} time opened up ({{when}}). Book: {{book_link}}', 'type, when, book_link, store'],
  ['form_assigned', 'Form to complete', 'A form from {{store}}',
    '<p>Hi {{first_name}},</p><p>Please complete a form before your next visit.</p><p><a href="{{link}}">Sign in to your account to fill it in</a></p>', '', 'first_name, link, store'],
  ['plan_shared', 'Care plan shared', 'Your care plan from {{store}}',
    '<p>Hi {{first_name}},</p><p>Your practitioner has shared a care plan with you.</p><p><a href="{{link}}">Sign in to view it</a></p>', '', 'first_name, link, store'],
  ['lesson_assigned', 'Lesson assigned', 'New reading from {{store}}',
    '<p>Hi {{first_name}},</p><p>Your practitioner has added something new to your learning centre.</p><p><a href="{{link}}">Sign in to read it</a></p>', '', 'first_name, link, store'],
  ['message_waiting', 'Secure message waiting', 'New secure message from {{store}}',
    '<p>Hi {{first_name}},</p><p>You have a new secure message from {{store}}. For your privacy it isn\'t included in this email.</p><p><a href="{{link}}">Sign in to read it</a></p>',
    '{{store}}: you have a new secure message. Sign in to read it.', 'first_name, link, store'],
  ['invoice_sent', 'Invoice', 'Invoice #{{number}} from {{store}}',
    '<p>Your invoice #{{number}} for {{amount}} is ready.{{due}}</p><p><a href="{{link}}">View and pay your invoice</a></p>', '', 'number, amount, due, link, store'],
  ['invoice_reminder', 'Invoice reminder', 'Reminder: invoice #{{number}} is due',
    '<p>Invoice #{{number}} has {{amount}} outstanding.{{due}}</p><p><a href="{{link}}">View and pay your invoice</a></p>', '', 'number, amount, due, link, store'],
  ['gift_card_received', 'Gift card received', 'You\'ve received a {{amount}} gift card from {{store}}',
    '<p>Hi {{first_name}},</p><p>{{sender}} sent you a <strong>{{amount}}</strong> gift card for {{store}}.</p><p style="white-space:pre-line">{{message}}</p><p>Your code: <strong style="font-size:18px;letter-spacing:1px">{{code}}</strong></p><p>Enter it at checkout.{{expires}} <a href="{{link}}">Check your balance</a>.</p>',
    '', 'first_name, sender, amount, message, code, expires, link, store'],
  ['downloads_ready', 'Downloads ready', 'Your downloads from order #{{number}}',
    '<p>Hi {{first_name}},</p><p>Thank you for your order. Your files are ready:</p><p style="white-space:pre-line">{{links}}</p><p>You can also find them on <a href="{{link}}">your order page</a>.</p>',
    '', 'first_name, number, links, link, store'],
  ['abandoned_cart', 'Abandoned cart reminder', 'You left something in your cart',
    '<p>Hi {{first_name}},</p><p>You left these in your cart at {{store}}:</p><p style="white-space:pre-line">{{items}}</p><p><a href="{{link}}">Return to your cart</a></p><p style="font-size:12px;color:#666">You received this because you agreed to hear from us at checkout. <a href="{{unsubscribe}}">Don\'t send these</a>.</p>',
    '', 'first_name, items, link, unsubscribe, store'],
];
const KEYS = TEMPLATES.map(([k]) => k);

async function template(key) {
  const def = TEMPLATES.find(([k]) => k === key);
  if (!def) throw new Error(`Unknown template ${key}`);
  const row = await get('SELECT * FROM notification_templates WHERE key = ?', key);
  return row || { key, subject: def[2], body: def[3], sms_body: def[4], email_enabled: 1, sms_enabled: def[4] ? 1 : 0 };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (text, vars, html) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] === undefined ? '' : html ? escapeHtml(vars[k]) : String(vars[k])));

// E.164: + then 8–15 digits.
const normalizePhone = (p) => { const s = String(p || '').replace(/[\s().-]/g, ''); return /^\+\d{8,15}$/.test(s) ? s : null; };
const smsConfigured = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

async function sendSms(to, body, key) {
  const id = await insert('INSERT INTO sms_outbox (to_number, body, template) VALUES (?, ?, ?)', to, body.slice(0, 640), key);
  if (!smsConfigured()) { await run("UPDATE sms_outbox SET status = 'logged' WHERE id = ?", id); return; }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body.slice(0, 640) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `Twilio ${res.status}`);
    await run("UPDATE sms_outbox SET status = 'sent', provider_id = ? WHERE id = ?", json.sid || '', id);
  } catch (err) {
    await run("UPDATE sms_outbox SET status = 'failed', error = ? WHERE id = ?", String(err.message || err).slice(0, 500), id);
  }
}

/**
 * Sends a templated message to a customer. who: { email, phone, sms_opt_in, email_reminders, first_name }.
 * reminder: true for automated reminders, which respect the customer's email reminder preference.
 * Never throws.
 */
async function send(key, who, vars = {}, { reminder = false } = {}) {
  try {
    const t = await template(key);
    const all_ = { store: settings.load('store').name, first_name: who.first_name || 'there', ...vars };
    if (t.email_enabled && who.email && !(reminder && who.email_reminders === 0)) {
      await mailer.sendRaw(who.email, fill(t.subject, all_, false), fill(t.body, all_, true));
      await run("UPDATE email_outbox SET template = ? WHERE id = (SELECT MAX(id) FROM email_outbox WHERE to_address = ?)", key, who.email);
    }
    const phone = normalizePhone(who.phone);
    if (t.sms_enabled && t.sms_body && who.sms_opt_in && phone) await sendSms(phone, fill(t.sms_body, all_, false), key);
  } catch (err) {
    console.error('[comms]', key, err.message);
  }
}

/* ---------- Staff notifications (in-app) ---------- */

/** Adds a notification for one staff member, or everyone holding `permission`. dedupe skips repeats. */
async function notifyStaff({ kind, title, link = '', permission = '', staffId = null, dedupe = null }) {
  try {
    await run('INSERT INTO notifications (staff_id, permission, kind, title, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING',
      staffId, permission, kind, String(title).slice(0, 300), link, dedupe);
  } catch (err) {
    console.error('[notify]', err.message);
  }
}

// Notifications a staff member can see (theirs, or for a permission they hold), newest first.
async function forStaff(staff, { unreadOnly = false, limit = 50 } = {}) {
  const perms = [...staff.permissions];
  return all(`SELECT n.*, r.read_at FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.staff_id = ?
    WHERE (n.staff_id = ? OR (n.staff_id IS NULL AND (n.permission = '' OR n.permission = ANY(?::text[])))) ${unreadOnly ? 'AND r.read_at IS NULL' : ''}
    AND n.created_at > now() - interval '60 days' ORDER BY n.id DESC LIMIT ?`, staff.id, staff.id, `{${perms.map((p) => `"${p}"`).join(',')}}`, limit);
}

module.exports = { TEMPLATES, KEYS, template, fill, escapeHtml, normalizePhone, smsConfigured, sendSms, send, notifyStaff, forStaff, base };
