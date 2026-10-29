'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../../db');
const settings = require('../../settings');
const mailer = require('../../mailer');
const { flash, requireOwner } = require('../../middleware');
const { toInt, parseMoney, asBool } = require('../../utils');
const { COUNTRIES } = require('../../countries');

const router = express.Router();

router.use(requireOwner);

const SECTIONS = [
  ['general', 'General', 'Store details, currency and order IDs'],
  ['payments', 'Payments', 'Card payments and manual payment methods'],
  ['checkout', 'Checkout', 'Customer accounts and checkout form'],
  ['shipping', 'Shipping and delivery', 'Shipping rates and zones'],
  ['taxes', 'Taxes and duties', 'Tax rates by region'],
  ['notifications', 'Notifications', 'Email sending and customer notifications'],
  ['policies', 'Policies', 'Refund, privacy, terms and shipping policies'],
  ['preferences', 'Preferences', 'SEO, tracking code and store password'],
  ['staff', 'Users and permissions', 'Staff accounts'],
];

router.use((req, res, next) => {
  res.locals.SECTIONS = SECTIONS;
  next();
});

router.get('/', (req, res) => res.render('admin/settings/index', { title: 'Settings' }));

// Copies the submitted keys that exist in a settings group's defaults, coercing booleans/numbers.
function patchFrom(group, body, { money = [], exclude = [] } = {}) {
  const defaults = settings.DEFAULTS[group];
  const patch = {};
  for (const [key, def] of Object.entries(defaults)) {
    if (exclude.includes(key)) continue;
    if (typeof def === 'boolean') patch[key] = asBool(body[key]);
    else if (money.includes(key)) patch[key] = parseMoney(body[key]) || 0;
    else if (typeof def === 'number') { if (body[key] !== undefined) patch[key] = Number(body[key]) || 0; }
    else if (typeof def === 'string' && body[key] !== undefined) patch[key] = String(body[key]);
  }
  return patch;
}

function simpleSection(section, group, exclude = []) {
  router.get(`/${section}`, (req, res) => {
    const extra = section === 'notifications' ? { outbox: all('SELECT id, to_address, subject, status, error, created_at FROM email_outbox ORDER BY id DESC LIMIT 25') } : {};
    res.render(`admin/settings/${section}`, { title: SECTIONS.find(([k]) => k === section)[1], s: settings.load(group), ...extra });
  });
  router.post(`/${section}`, (req, res) => {
    settings.save(group, patchFrom(group, req.body, { exclude }));
    flash(req, 'success', 'Settings saved.');
    res.redirect(`/admin/settings/${section}`);
  });
}

// The store password lives in the store group but is edited under Preferences.
simpleSection('general', 'store', ['password_enabled', 'password', 'password_message']);
simpleSection('checkout', 'checkout');
simpleSection('notifications', 'notifications');
simpleSection('policies', 'policies');

router.get('/preferences', (req, res) => {
  res.render('admin/settings/preferences', { title: 'Preferences', seo: settings.load('seo'), s: settings.load('store') });
});
router.post('/preferences', (req, res) => {
  settings.save('seo', patchFrom('seo', req.body));
  settings.save('store', {
    password_enabled: asBool(req.body.password_enabled),
    password: String(req.body.password || ''),
    password_message: String(req.body.password_message || ''),
  });
  flash(req, 'success', 'Preferences saved.');
  res.redirect('/admin/settings/preferences');
});

router.get('/email/:id', (req, res, next) => {
  const email = get('SELECT * FROM email_outbox WHERE id = ?', toInt(req.params.id));
  if (!email) return next();
  // Rendered inside a sandboxed iframe on the notifications page.
  res.set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; sandbox").send(email.html);
});

router.post('/notifications/test', async (req, res) => {
  await mailer.send(res.locals.staff.email, 'Test email from your store', 'welcome', { first_name: res.locals.staff.name });
  const last = get('SELECT status, error FROM email_outbox ORDER BY id DESC LIMIT 1');
  flash(req, last.status === 'failed' ? 'error' : 'success',
    last.status === 'failed' ? `Sending failed: ${last.error}` : last.status === 'sent' ? `Test email sent to ${res.locals.staff.email}.` : 'SMTP is not configured — the email was logged to the outbox below.');
  res.redirect('/admin/settings/notifications');
});

/* ---------- Payments ---------- */

router.get('/payments', (req, res) => res.render('admin/settings/payments', { title: 'Payments', s: settings.load('payments') }));

router.post('/payments', (req, res) => {
  const current = settings.load('payments');
  const manual = current.manual.map((m) => ({
    ...m,
    enabled: asBool(req.body.manual?.[m.id]?.enabled),
    name: String(req.body.manual?.[m.id]?.name || m.name),
    instructions: String(req.body.manual?.[m.id]?.instructions ?? m.instructions),
  }));
  const secret = String(req.body.stripe_secret_key || '').trim();
  const webhook = String(req.body.stripe_webhook_secret || '').trim();
  settings.save('payments', {
    manual,
    stripe_enabled: asBool(req.body.stripe_enabled),
    stripe_publishable_key: String(req.body.stripe_publishable_key || '').trim(),
    // Secrets are write-only in the form: blank keeps the stored value.
    stripe_secret_key: secret || current.stripe_secret_key,
    stripe_webhook_secret: webhook || current.stripe_webhook_secret,
    test_mode: asBool(req.body.test_mode),
  });
  flash(req, 'success', 'Payment settings saved.');
  res.redirect('/admin/settings/payments');
});

/* ---------- Shipping ---------- */

router.get('/shipping', (req, res) => {
  res.render('admin/settings/shipping', { title: 'Shipping and delivery', rates: all('SELECT * FROM shipping_rates ORDER BY position, id'), COUNTRIES });
});

router.post('/shipping', (req, res) => {
  const id = toInt(req.body.id);
  const countries = [].concat(req.body.countries || []).filter(Boolean);
  const cols = [String(req.body.name || 'Shipping').trim(), parseMoney(req.body.price) || 0, parseMoney(req.body.min_subtotal) || 0,
    parseMoney(req.body.max_subtotal), countries.length ? countries.join(',') : '*', String(req.body.delivery_estimate || ''), toInt(req.body.position)];
  if (id) run('UPDATE shipping_rates SET name = ?, price = ?, min_subtotal = ?, max_subtotal = ?, countries = ?, delivery_estimate = ?, position = ? WHERE id = ?', ...cols, id);
  else run('INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES (?, ?, ?, ?, ?, ?, ?)', ...cols);
  flash(req, 'success', 'Shipping rate saved.');
  res.redirect('/admin/settings/shipping');
});

router.post('/shipping/:id/delete', (req, res) => {
  run('DELETE FROM shipping_rates WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Shipping rate deleted.');
  res.redirect('/admin/settings/shipping');
});

/* ---------- Taxes ---------- */

router.get('/taxes', (req, res) => {
  res.render('admin/settings/taxes', { title: 'Taxes and duties', s: settings.load('taxes'), rates: all('SELECT * FROM tax_rates ORDER BY country, province'), COUNTRIES });
});

router.post('/taxes', (req, res) => {
  settings.save('taxes', {
    prices_include_tax: asBool(req.body.prices_include_tax),
    charge_tax_on_shipping: asBool(req.body.charge_tax_on_shipping),
    default_rate: Math.max(0, Number(req.body.default_rate) || 0),
  });
  flash(req, 'success', 'Tax settings saved.');
  res.redirect('/admin/settings/taxes');
});

router.post('/taxes/rates', (req, res) => {
  const country = String(req.body.country || '').toUpperCase();
  const province = String(req.body.province || '').trim().toUpperCase();
  const rate = Math.max(0, Number(req.body.rate) || 0);
  const name = String(req.body.name || 'Sales tax');
  const existing = get('SELECT id FROM tax_rates WHERE country = ? AND province = ?', country, province);
  if (existing) run('UPDATE tax_rates SET rate = ?, name = ? WHERE id = ?', rate, name, existing.id);
  else run('INSERT INTO tax_rates (country, province, name, rate) VALUES (?, ?, ?, ?)', country, province, name, rate);
  flash(req, 'success', 'Tax rate saved.');
  res.redirect('/admin/settings/taxes');
});

router.post('/taxes/rates/:id/delete', (req, res) => {
  run('DELETE FROM tax_rates WHERE id = ?', toInt(req.params.id));
  res.redirect('/admin/settings/taxes');
});

/* ---------- Staff ---------- */

router.get('/staff', (req, res) => {
  res.render('admin/settings/staff', { title: 'Users and permissions', members: all('SELECT id, email, name, role, last_login_at, created_at FROM staff ORDER BY id') });
});

router.post('/staff', (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (!email.includes('@') || password.length < 8) {
    flash(req, 'error', 'Enter a valid email and a temporary password of at least 8 characters.');
    return res.redirect('/admin/settings/staff');
  }
  if (get('SELECT 1 FROM staff WHERE email = ?', email)) {
    flash(req, 'error', 'That staff member already exists.');
    return res.redirect('/admin/settings/staff');
  }
  run('INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, ?)', email, String(req.body.name || email),
    bcrypt.hashSync(password, 10), req.body.role === 'owner' ? 'owner' : 'staff');
  flash(req, 'success', 'Staff account created. Share the temporary password with them securely.');
  res.redirect('/admin/settings/staff');
});

router.post('/staff/:id/delete', (req, res) => {
  const id = toInt(req.params.id);
  const owners = get("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'").n;
  const target = get('SELECT * FROM staff WHERE id = ?', id);
  if (!target || id === res.locals.staff.id || (target.role === 'owner' && owners <= 1)) {
    flash(req, 'error', 'You cannot remove yourself or the last owner.');
  } else {
    run('DELETE FROM staff WHERE id = ?', id);
    run("DELETE FROM sessions WHERE data LIKE ?", `%"staffId":${id}%`);
    flash(req, 'success', 'Staff account removed.');
  }
  res.redirect('/admin/settings/staff');
});

module.exports = router;
