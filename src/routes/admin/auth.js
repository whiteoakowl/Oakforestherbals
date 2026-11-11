'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { get, run, insert } = require('../../db');
const settings = require('../../settings');
const { flash, throttle } = require('../../middleware');
const audit = require('../../audit');
const twofactor = require('../../twofactor');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/admin') ? n : '/admin');

async function signIn(req, staffId, done) {
  await run('UPDATE staff SET last_login_at = now() WHERE id = ?', staffId);
  const { cart } = req.session;
  req.session.regenerate(() => {
    Object.assign(req.session, { cart, staffId, pending2fa: null });
    done();
  });
}

// When SETUP_KEY is set (recommended on a public deployment), creating the owner requires it.
function setupKeyOk(sent) {
  const expected = process.env.SETUP_KEY || '';
  if (!expected) return true;
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// First-run wizard: creates the owner account when no staff exist yet.
router.get('/setup', async (req, res) => {
  if (await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'Set up your store', needsKey: Boolean(process.env.SETUP_KEY) });
});

router.post('/setup', async (req, res) => {
  if (await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  const { name = '', email = '', password = '', store_name = '' } = req.body;
  if (!setupKeyOk(req.body.setup_key)) {
    flash(req, 'error', 'The setup key is incorrect.');
    return res.redirect('/admin/setup');
  }
  if (!email.includes('@') || password.length < 8 || !name.trim()) {
    flash(req, 'error', 'Enter your name, a valid email and a password of at least 8 characters.');
    return res.redirect('/admin/setup');
  }
  const id = await insert("INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')",
    email.trim(), name.trim(), bcrypt.hashSync(password, 10));
  if (store_name.trim()) await settings.save('store', { name: store_name.trim(), email: email.trim() });
  await audit.record(req, 'staff.owner_setup', { entityType: 'staff', entityId: id, actor: { type: 'staff', id, name: name.trim() }, details: { email: email.trim() } });
  await signIn(req, id, () => res.redirect('/admin'));
});

router.get('/login', async (req, res) => {
  if (res.locals.staff) return res.redirect('/admin');
  if (!await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/setup');
  res.render('admin/login', { title: 'Log in', next: safeNext(req.query.next) });
});

router.post('/login', throttle('staff'), async (req, res) => {
  const staff = await get('SELECT * FROM staff WHERE email = ?', String(req.body.email || '').trim());
  if (!staff || !bcrypt.compareSync(String(req.body.password || ''), staff.password_hash)) {
    await audit.record(req, 'staff.login_failed', { details: { email: String(req.body.email || '').trim().slice(0, 200) } });
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect(`/admin/login?next=${encodeURIComponent(safeNext(req.body.next))}`);
  }
  if (staff.totp_enabled_at) {
    // Password was right; the code from their authenticator app is still needed.
    req.session.pending2fa = { staffId: staff.id, next: safeNext(req.body.next), at: Date.now(), attempts: 0 };
    return res.redirect('/admin/login/verify');
  }
  await audit.record(req, 'staff.login', { entityType: 'staff', entityId: staff.id, actor: { type: 'staff', id: staff.id, name: staff.name } });
  await signIn(req, staff.id, () => res.redirect(safeNext(req.body.next)));
});

const PENDING_MS = 5 * 60 * 1000;
const pending = (req) => {
  const p = req.session.pending2fa;
  return p && Date.now() - p.at < PENDING_MS && p.attempts < 5 ? p : null;
};

router.get('/login/verify', (req, res) => {
  if (!pending(req)) { req.session.pending2fa = null; return res.redirect('/admin/login'); }
  res.render('admin/login-verify', { title: 'Two-step sign-in' });
});

router.post('/login/verify', throttle('staff2fa'), async (req, res) => {
  const p = pending(req);
  if (!p) {
    req.session.pending2fa = null;
    flash(req, 'error', 'That took too long or had too many tries. Please sign in again.');
    return res.redirect('/admin/login');
  }
  const staff = await get('SELECT id, name, email FROM staff WHERE id = ?', p.staffId);
  const result = staff ? await twofactor.check(staff.id, req.body.code) : { ok: false };
  if (!result.ok) {
    p.attempts += 1;
    await audit.record(req, 'staff.two_factor_failed', { entityType: 'staff', entityId: p.staffId, actor: staff ? { type: 'staff', id: staff.id, name: staff.name } : undefined });
    flash(req, 'error', 'That code didn’t work. Check your authenticator app and try again.');
    return res.redirect('/admin/login/verify');
  }
  await audit.record(req, 'staff.login', { entityType: 'staff', entityId: staff.id, actor: { type: 'staff', id: staff.id, name: staff.name }, details: { two_factor: result.recovery ? 'recovery_code' : 'app' } });
  if (result.recovery) flash(req, 'info', `You used a recovery code. ${await twofactor.remainingCodes(staff.id)} left — make new ones under Your profile if you're running low.`);
  await signIn(req, staff.id, () => res.redirect(p.next));
});

router.post('/logout', async (req, res) => {
  if (res.locals.staff) await audit.record(req, 'staff.logout', { entityType: 'staff', entityId: res.locals.staff.id });
  req.session.regenerate(() => res.redirect('/admin/login'));
});

module.exports = router;
