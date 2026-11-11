'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run, insert } = require('../../db');
const settings = require('../../settings');
const mailer = require('../../mailer');
const { flash, requirePermission } = require('../../middleware');
const audit = require('../../audit');
const { toInt, parseMoney, asBool } = require('../../utils');
const { COUNTRIES } = require('../../countries');

const router = express.Router();

// [key, label, description, permission]
const SECTIONS = [
  ['general', 'General', 'Store details, currency and order IDs', 'settings.manage'],
  ['payments', 'Payments', 'Card payments and manual payment methods', 'settings.manage'],
  ['checkout', 'Checkout', 'Customer accounts and checkout form', 'settings.manage'],
  ['shipping', 'Shipping and delivery', 'Shipping rates and zones', 'settings.manage'],
  ['taxes', 'Taxes and duties', 'Tax rates by region', 'settings.manage'],
  ['store-features', 'Store features', 'Reviews, gift cards, downloads and cart reminders', 'settings.manage'],
  ['notifications', 'Notifications', 'Email sending and customer notifications', 'settings.manage'],
  ['policies', 'Policies', 'Refund, privacy, terms and shipping policies', 'settings.manage'],
  ['preferences', 'Preferences', 'SEO, tracking code and store password', 'settings.manage'],
  ['security', 'Security', 'Two-step sign-in and the encryption key', 'settings.manage'],
  ['staff', 'Users', 'Staff accounts and their roles', 'staff.manage'],
  ['roles', 'Roles and permissions', 'What each role can see and do', 'staff.manage'],
  ['audit', 'Audit log', 'Sign-ins, permission changes and other security events', 'audit.view'],
  ['../communications', 'Communications', 'Message templates, email and SMS logs, automations', 'settings.manage'],
];

// Only the sections this staff member may open are listed.
function sectionsFor(res) {
  return SECTIONS.filter(([, , , perm]) => res.locals.can(perm));
}

router.use(async (req, res, next) => {
  res.locals.SECTIONS = sectionsFor(res);
  next();
});

router.get('/', async (req, res) => {
  if (!res.locals.SECTIONS.length) return requirePermission('settings.manage')(req, res);
  res.render('admin/settings/index', { title: 'Settings' });
});

const staffGate = requirePermission('staff.manage');
const settingsGate = requirePermission('settings.manage');
router.use((req, res, next) => (req.path.startsWith('/staff') ? staffGate : settingsGate)(req, res, next));

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
  router.get(`/${section}`, async (req, res) => {
    const extra = section === 'notifications' ? { outbox: await all('SELECT id, to_address, subject, status, error, created_at FROM email_outbox ORDER BY id DESC LIMIT 25') } : {};
    res.render(`admin/settings/${section}`, { title: SECTIONS.find(([k]) => k === section)[1], s: settings.load(group), ...extra });
  });
  router.post(`/${section}`, async (req, res) => {
    await settings.save(group, patchFrom(group, req.body, { exclude }));
    await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: section });
    flash(req, 'success', 'Settings saved.');
    res.redirect(`/admin/settings/${section}`);
  });
}

// The store password lives in the store group but is edited under Preferences.
simpleSection('general', 'store', ['password_enabled', 'password', 'password_message']);
simpleSection('checkout', 'checkout');
simpleSection('notifications', 'notifications');
simpleSection('policies', 'policies');

router.get('/preferences', async (req, res) => {
  res.render('admin/settings/preferences', { title: 'Preferences', seo: settings.load('seo'), s: settings.load('store') });
});
router.post('/preferences', async (req, res) => {
  await settings.save('seo', patchFrom('seo', req.body));
  await settings.save('store', {
    password_enabled: asBool(req.body.password_enabled),
    password: String(req.body.password || ''),
    password_message: String(req.body.password_message || ''),
  });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'preferences' });
  flash(req, 'success', 'Preferences saved.');
  res.redirect('/admin/settings/preferences');
});

router.get('/email/:id', async (req, res, next) => {
  const email = await get('SELECT * FROM email_outbox WHERE id = ?', toInt(req.params.id));
  if (!email) return next();
  // Rendered inside a sandboxed iframe on the notifications page.
  res.set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; sandbox").send(email.html);
});

router.post('/notifications/test', async (req, res) => {
  await mailer.send(res.locals.staff.email, 'Test email from your store', 'welcome', { first_name: res.locals.staff.name });
  const last = await get('SELECT status, error FROM email_outbox ORDER BY id DESC LIMIT 1');
  flash(req, last.status === 'failed' ? 'error' : 'success',
    last.status === 'failed' ? `Sending failed: ${last.error}` : last.status === 'sent' ? `Test email sent to ${res.locals.staff.email}.` : 'SMTP is not configured — the email was logged to the outbox below.');
  res.redirect('/admin/settings/notifications');
});

/* ---------- Payments ---------- */

router.get('/payments', async (req, res) => res.render('admin/settings/payments', { title: 'Payments', s: settings.load('payments') }));

router.post('/payments', async (req, res) => {
  const current = settings.load('payments');
  const manual = current.manual.map((m) => ({
    ...m,
    enabled: asBool(req.body.manual?.[m.id]?.enabled),
    name: String(req.body.manual?.[m.id]?.name || m.name),
    instructions: String(req.body.manual?.[m.id]?.instructions ?? m.instructions),
  }));
  const secret = String(req.body.stripe_secret_key || '').trim();
  const webhook = String(req.body.stripe_webhook_secret || '').trim();
  await settings.save('payments', {
    manual,
    stripe_enabled: asBool(req.body.stripe_enabled),
    stripe_publishable_key: String(req.body.stripe_publishable_key || '').trim(),
    // Secrets are write-only in the form: blank keeps the stored value.
    stripe_secret_key: secret || current.stripe_secret_key,
    stripe_webhook_secret: webhook || current.stripe_webhook_secret,
    test_mode: asBool(req.body.test_mode),
  });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'payments', details: { stripe_enabled: asBool(req.body.stripe_enabled), stripe_secret_changed: Boolean(secret), webhook_secret_changed: Boolean(webhook) } });
  flash(req, 'success', 'Payment settings saved.');
  res.redirect('/admin/settings/payments');
});

/* ---------- Shipping ---------- */

router.get('/shipping', async (req, res) => {
  res.render('admin/settings/shipping', { title: 'Shipping and delivery', rates: await all('SELECT * FROM shipping_rates ORDER BY position, id'), COUNTRIES });
});

router.post('/shipping', async (req, res) => {
  const id = toInt(req.body.id);
  const countries = [].concat(req.body.countries || []).filter(Boolean);
  const cols = [String(req.body.name || 'Shipping').trim(), parseMoney(req.body.price) || 0, parseMoney(req.body.min_subtotal) || 0,
    parseMoney(req.body.max_subtotal), countries.length ? countries.join(',') : '*', String(req.body.delivery_estimate || ''), toInt(req.body.position)];
  if (id) await run('UPDATE shipping_rates SET name = ?, price = ?, min_subtotal = ?, max_subtotal = ?, countries = ?, delivery_estimate = ?, position = ? WHERE id = ?', ...cols, id);
  else await run('INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES (?, ?, ?, ?, ?, ?, ?)', ...cols);
  flash(req, 'success', 'Shipping rate saved.');
  res.redirect('/admin/settings/shipping');
});

router.post('/shipping/:id/delete', async (req, res) => {
  await run('DELETE FROM shipping_rates WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Shipping rate deleted.');
  res.redirect('/admin/settings/shipping');
});

/* ---------- Taxes ---------- */

router.get('/taxes', async (req, res) => {
  res.render('admin/settings/taxes', { title: 'Taxes and duties', s: settings.load('taxes'), rates: await all('SELECT * FROM tax_rates ORDER BY country, province'), COUNTRIES });
});

router.post('/taxes', async (req, res) => {
  await settings.save('taxes', {
    prices_include_tax: asBool(req.body.prices_include_tax),
    charge_tax_on_shipping: asBool(req.body.charge_tax_on_shipping),
    default_rate: Math.max(0, Number(req.body.default_rate) || 0),
  });
  flash(req, 'success', 'Tax settings saved.');
  res.redirect('/admin/settings/taxes');
});

router.post('/taxes/rates', async (req, res) => {
  const country = String(req.body.country || '').toUpperCase();
  const province = String(req.body.province || '').trim().toUpperCase();
  const rate = Math.max(0, Number(req.body.rate) || 0);
  const name = String(req.body.name || 'Sales tax');
  const existing = await get('SELECT id FROM tax_rates WHERE country = ? AND province = ?', country, province);
  if (existing) await run('UPDATE tax_rates SET rate = ?, name = ? WHERE id = ?', rate, name, existing.id);
  else await run('INSERT INTO tax_rates (country, province, name, rate) VALUES (?, ?, ?, ?)', country, province, name, rate);
  flash(req, 'success', 'Tax rate saved.');
  res.redirect('/admin/settings/taxes');
});

router.post('/taxes/rates/:id/delete', async (req, res) => {
  await run('DELETE FROM tax_rates WHERE id = ?', toInt(req.params.id));
  res.redirect('/admin/settings/taxes');
});

/* ---------- Staff ---------- */

/* ---------- Store features: reviews, gift cards, downloads, abandoned carts ---------- */

router.get('/store-features', (req, res) => res.render('admin/settings/store-features', {
  title: 'Store features', reviews: settings.load('reviews'), gift: settings.load('gift_cards'), downloads: settings.load('downloads'), abandoned: settings.load('abandoned_cart'),
  subs: settings.load('subscriptions'), stripeReady: require('../../stripe').stripeConfigured(),
}));

router.post('/store-features', async (req, res) => {
  const num = (v, min, max, d) => Math.max(min, Math.min(max, toInt(v, d)));
  await settings.save('reviews', { enabled: asBool(req.body.reviews_enabled), require_purchase: asBool(req.body.reviews_require_purchase), auto_publish: asBool(req.body.reviews_auto_publish) });
  await settings.save('gift_cards', { expiry_months: num(req.body.gift_expiry_months, 0, 120, 0) });
  await settings.save('downloads', { max_downloads: num(req.body.max_downloads, 0, 1000, 5), expiry_days: num(req.body.expiry_days, 0, 3650, 30) });
  await settings.save('subscriptions', { enabled: asBool(req.body.subscriptions_enabled), shipping_price: Math.max(0, parseMoney(req.body.subscription_shipping) || 0), automatic_tax: asBool(req.body.subscriptions_automatic_tax) });
  await settings.save('abandoned_cart', { enabled: asBool(req.body.abandoned_enabled), delay_hours: num(req.body.abandoned_delay_hours, 1, 168, 4), require_consent: asBool(req.body.abandoned_require_consent) });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'store-features' });
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings/store-features');
});

/* ---------- Security: two-step sign-in rule and encryption key rotation ---------- */

router.get('/security', async (req, res) => {
  const vault = require('../../vault');
  const isOwner = res.locals.staff.role === 'owner';
  res.render('admin/settings/security', {
    title: 'Security', s: settings.load('security'), keyReady: vault.configured(),
    rotation: isOwner && vault.configured() ? await require('../../keyrotation').status() : null, isOwner,
    without: (await all('SELECT s.name, s.email, r.name AS role_name FROM staff s JOIN roles r ON r.key = s.role WHERE s.totp_enabled_at IS NULL ORDER BY s.name')),
  });
});

router.post('/security', async (req, res) => {
  const rule = ['none', 'clinical', 'all'].includes(req.body.require_two_factor) ? req.body.require_two_factor : 'none';
  const idle = Math.max(0, Math.min(1440, toInt(req.body.clinical_idle_minutes, 30)));
  await settings.save('security', { require_two_factor: rule, clinical_idle_minutes: idle });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'security', details: { require_two_factor: rule } });
  flash(req, 'success', 'Security settings saved.');
  res.redirect('/admin/settings/security');
});

// Owner only: re-encrypts a batch of records with the current key, then comes back for more.
router.post('/security/reencrypt', async (req, res) => {
  if (res.locals.staff.role !== 'owner') return res.status(403).render('admin/error', { title: 'Permission required', message: 'Only an owner can re-encrypt records.' });
  const out = await require('../../keyrotation').runBatch();
  await audit.record(req, 'encryption.reencrypted', { details: { values: out.values, files: out.files, errors: out.errors.length } });
  flash(req, out.errors.length ? 'error' : 'success', `Re-encrypted ${out.values} value(s) and ${out.files} file(s).${out.errors.length ? ` ${out.errors.length} could not be read: ${out.errors.slice(0, 3).join('; ')}` : ''}`);
  res.redirect('/admin/settings/security');
});

// Clears another staff member's two-step sign-in (lost phone and recovery codes).
router.post('/staff/:id/reset-two-factor', async (req, res) => {
  const id = toInt(req.params.id);
  const target = await get('SELECT * FROM staff WHERE id = ?', id);
  if (!target || id === res.locals.staff.id || (target.role === 'owner' && res.locals.staff.role !== 'owner')) {
    flash(req, 'error', 'Only an owner can reset an owner’s two-step sign-in, and you can’t reset your own here.');
  } else {
    await require('../../twofactor').disable(id);
    await endStaffSessions(id);
    await audit.record(req, 'staff.two_factor_reset', { entityType: 'staff', entityId: id, details: { email: target.email } });
    flash(req, 'success', `Two-step sign-in reset for ${target.name}. They'll set it up again at their next sign-in.`);
  }
  res.redirect('/admin/settings/staff');
});

// Sets a temporary password for another staff member (they must change it at their next login).
router.post('/staff/:id/password', async (req, res) => {
  const id = toInt(req.params.id);
  const target = await get('SELECT * FROM staff WHERE id = ?', id);
  const password = String(req.body.password || '');
  if (!target || id === res.locals.staff.id) flash(req, 'error', 'Change your own password under Your profile.');
  else if (target.role === 'owner' && res.locals.staff.role !== 'owner') flash(req, 'error', 'Only an owner can change an owner’s password.');
  else if (password.length < 8) flash(req, 'error', 'The temporary password must be at least 8 characters.');
  else {
    await run('UPDATE staff SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(password, 10), id);
    await endStaffSessions(id);
    await audit.record(req, 'staff.password_set_by_admin', { entityType: 'staff', entityId: id, details: { email: target.email } });
    flash(req, 'success', `Temporary password set for ${target.name}. Share it with them securely; they’ll choose their own when they log in.`);
  }
  res.redirect('/admin/settings/staff');
});

router.get('/staff', async (req, res) => {
  res.render('admin/settings/staff', {
    title: 'Users',
    members: await all('SELECT s.id, s.email, s.name, s.role, s.last_login_at, s.created_at, s.totp_enabled_at, r.name AS role_name FROM staff s JOIN roles r ON r.key = s.role ORDER BY s.id'),
    roles: await all("SELECT key, name, description FROM roles ORDER BY key = 'owner' DESC, is_system DESC, name"),
  });
});

// Signs a staff member out everywhere. Matches the id exactly ("staffId":5 must not hit 50).
const endStaffSessions = (id) => run('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?', `%"staffId":${id},%`, `%"staffId":${id}}%`);

// Only an owner can hand out (or take away) ownership.
async function roleAllowed(res, roleKey) {
  if (!await get('SELECT 1 FROM roles WHERE key = ?', roleKey)) return false;
  return roleKey !== 'owner' || res.locals.staff.role === 'owner';
}

router.post('/staff', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (!email.includes('@') || password.length < 8) {
    flash(req, 'error', 'Enter a valid email and a temporary password of at least 8 characters.');
    return res.redirect('/admin/settings/staff');
  }
  if (await get('SELECT 1 FROM staff WHERE email = ?', email)) {
    flash(req, 'error', 'That staff member already exists.');
    return res.redirect('/admin/settings/staff');
  }
  const role = String(req.body.role || 'staff');
  if (!await roleAllowed(res, role)) {
    flash(req, 'error', role === 'owner' ? 'Only an owner can create another owner.' : 'Choose a valid role.');
    return res.redirect('/admin/settings/staff');
  }
  const newId = await insert('INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, ?)', email, String(req.body.name || email),
    bcrypt.hashSync(password, 10), role);
  await audit.record(req, 'staff.created', { entityType: 'staff', entityId: newId, details: { email, role } });
  flash(req, 'success', 'Staff account created. Share the temporary password with them securely.');
  res.redirect('/admin/settings/staff');
});

router.post('/staff/:id/role', async (req, res) => {
  const id = toInt(req.params.id);
  const role = String(req.body.role || '');
  const target = await get('SELECT * FROM staff WHERE id = ?', id);
  const owners = (await get("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'")).n;
  if (!target || id === res.locals.staff.id) {
    flash(req, 'error', 'You cannot change your own role.');
  } else if (!await roleAllowed(res, role) || (target.role === 'owner' && res.locals.staff.role !== 'owner')) {
    flash(req, 'error', 'Only an owner can grant or remove ownership.');
  } else if (target.role === 'owner' && role !== 'owner' && owners <= 1) {
    flash(req, 'error', 'The store needs at least one owner.');
  } else if (target.role !== role) {
    await run('UPDATE staff SET role = ? WHERE id = ?', role, id);
    // End their sessions so the new permissions apply from their next sign-in.
    await endStaffSessions(id);
    await audit.record(req, 'staff.role_changed', { entityType: 'staff', entityId: id, details: { email: target.email, from: target.role, to: role } });
    flash(req, 'success', `${target.name} is now ${(await get('SELECT name FROM roles WHERE key = ?', role)).name}. They will need to sign in again.`);
  }
  res.redirect('/admin/settings/staff');
});

router.post('/staff/:id/delete', async (req, res) => {
  const id = toInt(req.params.id);
  const owners = (await get("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'")).n;
  const target = await get('SELECT * FROM staff WHERE id = ?', id);
  if (!target || id === res.locals.staff.id || (target.role === 'owner' && owners <= 1)) {
    flash(req, 'error', 'You cannot remove yourself or the last owner.');
  } else if (target.role === 'owner' && res.locals.staff.role !== 'owner') {
    flash(req, 'error', 'Only an owner can remove another owner.');
  } else {
    await run('DELETE FROM staff WHERE id = ?', id);
    await audit.record(req, 'staff.removed', { entityType: 'staff', entityId: id, details: { email: target.email, role: target.role } });
    await endStaffSessions(id);
    flash(req, 'success', 'Staff account removed.');
  }
  res.redirect('/admin/settings/staff');
});

module.exports = router;
module.exports.sectionsFor = sectionsFor;
