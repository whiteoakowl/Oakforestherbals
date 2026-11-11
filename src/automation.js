'use strict';
// Scheduled automations. Netlify runs netlify/functions/scheduled.js hourly; the admin can also
// run them by hand. Every step is idempotent, so running twice never double-sends.
const { get, all, run, insert } = require('./db');
const settings = require('./settings');
const scheduling = require('./scheduling');
const inventory = require('./inventory');
const comms = require('./comms');

async function appointmentReminders(now) {
  const hours = Number(settings.load('booking').reminder_hours) || 24;
  const due = await all(`SELECT a.*, s.name AS staff_name, c.email, c.first_name, c.phone, c.sms_opt_in, c.email_reminders FROM appointments a
    JOIN customers c ON c.id = a.customer_id LEFT JOIN staff s ON s.id = a.staff_id
    WHERE a.status IN ('booked', 'confirmed') AND a.reminder_sent_at IS NULL AND a.starts_at > ? AND a.starts_at <= ?`, now.toISOString(), new Date(now.getTime() + hours * 3600000).toISOString());
  for (const a of due) {
    // Claim the row first so overlapping runs can't both send.
    const claimed = await run('UPDATE appointments SET reminder_sent_at = now() WHERE id = ? AND reminder_sent_at IS NULL', a.id);
    if (!claimed.changes) continue;
    await require('./routes/admin/schedule').appointmentEmail(a, 'appointment_reminder');
  }
  return due.length;
}

async function invoiceReminders(now) {
  const days = Number(settings.load('automation').invoice_reminder_days) || 7;
  const today = now.toISOString().slice(0, 10);
  const due = await all(`SELECT i.*, c.first_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('open', 'partial') AND i.due_on < ? AND i.email != ''
    AND (i.reminded_at IS NULL OR i.reminded_at < ?)`, today, new Date(now.getTime() - days * 86400000).toISOString());
  const store = settings.load('store');
  const { formatMoney } = require('./utils');
  for (const i of due) {
    const claimed = await run('UPDATE invoices SET reminded_at = now() WHERE id = ? AND (reminded_at IS NULL OR reminded_at < ?)', i.id, new Date(now.getTime() - days * 86400000).toISOString());
    if (!claimed.changes) continue;
    await comms.send('invoice_reminder', { email: i.email, first_name: i.first_name }, { number: i.number, amount: formatMoney(i.total - i.paid_total, store.currency_symbol), due: ` It was due on ${String(i.due_on instanceof Date ? i.due_on.toISOString() : i.due_on).slice(0, 10)}.`, link: `${comms.base()}/invoices/${i.token}` }, { reminder: true });
  }
  return due.length;
}

// Once a day: low stock, expiring lots, plan reviews and batches waiting — as in-app notifications.
async function dailyDigest(now) {
  const day = scheduling.utcToZoned(now, settings.load('booking').timezone).day;
  const a = settings.load('automation');
  if (a.last_digest_day === day) return { skipped: true };
  await settings.save('automation', { last_digest_day: day });
  const out = { low: 0, expiring: 0, reviews: 0, batches: 0 };
  if (a.inventory_digest) {
    const alerts = await inventory.alerts();
    out.low = alerts.low.length;
    out.expiring = alerts.expiring.length;
    if (out.low) await comms.notifyStaff({ kind: 'inventory', title: `${out.low} material(s) at or below their reorder point`, link: '/admin/inventory?filter=low', permission: 'inventory.manage', dedupe: `low-${day}` });
    if (out.expiring) await comms.notifyStaff({ kind: 'inventory', title: `${out.expiring} material(s) expired or expiring within ${alerts.warnDays} days`, link: '/admin/inventory?filter=expiring', permission: 'inventory.manage', dedupe: `exp-${day}` });
    const lowProducts = (await get('SELECT COUNT(*) AS n FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = \'active\' AND v.track_inventory = 1 AND v.inventory_qty <= 3')).n;
    if (lowProducts) await comms.notifyStaff({ kind: 'inventory', title: `${lowProducts} product variant(s) have 3 or fewer in stock`, link: '/admin/products/inventory', permission: 'products.manage', dedupe: `lowprod-${day}` });
  }
  if (a.plan_review_alerts) {
    const reviews = await all(`SELECT cp.id, cp.patient_id FROM care_plans cp WHERE cp.status = 'active' AND cp.review_date = ?`, day);
    out.reviews = reviews.length;
    for (const r of reviews) {
      const staff = await all('SELECT staff_id FROM practitioner_assignments WHERE patient_id = ?', r.patient_id);
      for (const s of staff) await comms.notifyStaff({ kind: 'follow_up', title: 'A care plan is due for review today', link: `/admin/clinic/patients/${r.patient_id}?tab=plans&plan=${r.id}`, staffId: s.staff_id, dedupe: `review-${r.id}-${day}-${s.staff_id}` });
    }
  }
  const waiting = (await get("SELECT COUNT(*) AS n FROM production_batches WHERE status IN ('awaiting_qc', 'completed')")).n;
  out.batches = waiting;
  if (waiting) await comms.notifyStaff({ kind: 'batch', title: `${waiting} batch(es) awaiting quality review or release`, link: '/admin/production', permission: 'production.approve', dedupe: `batches-${day}` });
  return out;
}

async function runAll(trigger = 'manual', now = new Date()) {
  const runId = await insert('INSERT INTO automation_runs (trigger) VALUES (?)', trigger);
  const a = settings.load('automation');
  const summary = {};
  try {
    if (a.appointment_reminders) summary.reminders = await appointmentReminders(now);
    if (a.invoice_reminders) summary.invoices = await invoiceReminders(now);
    summary.carts = await require('./abandoned').remind(now);
    summary.digest = await dailyDigest(now);
    await run('UPDATE automation_runs SET finished_at = now(), summary = ? WHERE id = ?', JSON.stringify(summary), runId);
  } catch (err) {
    await run('UPDATE automation_runs SET finished_at = now(), error = ? WHERE id = ?', String(err.message || err).slice(0, 1000), runId);
    throw err;
  }
  return summary;
}

module.exports = { runAll, appointmentReminders, invoiceReminders, dailyDigest };
