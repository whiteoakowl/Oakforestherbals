'use strict';
// Communications: message templates, email and SMS logs, automation settings and runs, and the
// staff notification centre.
const express = require('express');
const { get, all, run } = require('../../db');
const comms = require('../../comms');
const settings = require('../../settings');
const automation = require('../../automation');
const audit = require('../../audit');
const { flash, requirePermission } = require('../../middleware');
const { toInt, asBool } = require('../../utils');

const router = express.Router();

/* ---------- Notifications (every staff member) ---------- */

router.get('/notifications', async (req, res) => {
  const list = await comms.forStaff(res.locals.staff, { limit: 100 });
  res.render('admin/communications/notifications', { title: 'Notifications', list });
});

router.post('/notifications/read', async (req, res) => {
  const ids = req.body.id ? [toInt(req.body.id)] : (await comms.forStaff(res.locals.staff, { unreadOnly: true, limit: 500 })).map((n) => n.id);
  for (const id of ids) await run('INSERT INTO notification_reads (notification_id, staff_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, res.locals.staff.id);
  if (req.body.go && String(req.body.go).startsWith('/admin')) return res.redirect(req.body.go);
  res.redirect('/admin/communications/notifications');
});

/* ---------- Templates, logs and automations (settings permission) ---------- */

router.use(requirePermission('settings.manage'));

router.get('/', async (req, res) => {
  const templates = [];
  for (const [key, label, , , , placeholders] of comms.TEMPLATES) templates.push({ ...(await comms.template(key)), label, placeholders });
  const emails = await all('SELECT id, to_address, subject, template, status, error, created_at FROM email_outbox ORDER BY id DESC LIMIT 40');
  const sms = await all('SELECT * FROM sms_outbox ORDER BY id DESC LIMIT 40');
  const runs = await all('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 10');
  res.render('admin/communications/index', { title: 'Communications', templates, emails, sms, runs, a: settings.load('automation'), smsReady: comms.smsConfigured(), optedIn: (await get('SELECT COUNT(*) AS n FROM customers WHERE sms_opt_in = 1')).n });
});

router.get('/templates/:key', async (req, res, next) => {
  const def = comms.TEMPLATES.find(([k]) => k === req.params.key);
  if (!def) return next();
  const t = await comms.template(def[0]);
  const sample = { first_name: 'Robin', type: 'Initial consultation', practitioner: 'Ann', when: 'Mon, Jan 5, 10:00 AM EST', where: '1 Forest Lane', note: '', link: `${comms.base()}/account`, book_link: `${comms.base()}/book`, number: '1042', amount: '$90.00', due: ' It\'s due on 2026-01-20.', store: res.locals.store.name };
  res.render('admin/communications/template', { title: def[1], t, def, preview: { subject: comms.fill(t.subject, sample, false), body: comms.fill(t.body, sample, true), sms: comms.fill(t.sms_body, sample, false) } });
});

router.post('/templates/:key', async (req, res, next) => {
  const def = comms.TEMPLATES.find(([k]) => k === req.params.key);
  if (!def) return next();
  if (req.body.reset === '1') {
    await run('DELETE FROM notification_templates WHERE key = ?', def[0]);
    flash(req, 'success', 'Template reset to the default.');
    return res.redirect(`/admin/communications/templates/${def[0]}`);
  }
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (!subject || !body) { flash(req, 'error', 'A template needs a subject and a message.'); return res.redirect(`/admin/communications/templates/${def[0]}`); }
  await run(`INSERT INTO notification_templates (key, subject, body, sms_body, email_enabled, sms_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, now())
    ON CONFLICT (key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, sms_body = EXCLUDED.sms_body, email_enabled = EXCLUDED.email_enabled, sms_enabled = EXCLUDED.sms_enabled, updated_at = now()`,
  def[0], subject, body, String(req.body.sms_body || '').trim().slice(0, 640), asBool(req.body.email_enabled) ? 1 : 0, asBool(req.body.sms_enabled) ? 1 : 0);
  await audit.record(req, 'template.updated', { entityType: 'template', entityId: def[0] });
  flash(req, 'success', 'Template saved.');
  res.redirect(`/admin/communications/templates/${def[0]}`);
});

router.post('/automations', async (req, res) => {
  await settings.save('automation', {
    appointment_reminders: asBool(req.body.appointment_reminders), invoice_reminders: asBool(req.body.invoice_reminders),
    invoice_reminder_days: Math.max(1, toInt(req.body.invoice_reminder_days, 7)), inventory_digest: asBool(req.body.inventory_digest), plan_review_alerts: asBool(req.body.plan_review_alerts),
  });
  flash(req, 'success', 'Automation settings saved.');
  res.redirect('/admin/communications');
});

router.post('/automations/run', async (req, res) => {
  const summary = await automation.runAll(`manual: ${res.locals.staff.name}`);
  flash(req, 'success', `Automations ran: ${summary.reminders || 0} appointment reminder(s), ${summary.invoices || 0} invoice reminder(s)${summary.digest && summary.digest.skipped ? '; today\'s digest was already sent' : ''}.`);
  res.redirect('/admin/communications');
});

module.exports = router;
