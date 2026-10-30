'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { get, run, insert } = require('../../db');
const settings = require('../../settings');
const { flash, throttle } = require('../../middleware');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/admin') ? n : '/admin');

async function signIn(req, staffId, done) {
  await run('UPDATE staff SET last_login_at = now() WHERE id = ?', staffId);
  const { cart } = req.session;
  req.session.regenerate(() => {
    Object.assign(req.session, { cart, staffId });
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
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect(`/admin/login?next=${encodeURIComponent(safeNext(req.body.next))}`);
  }
  await signIn(req, staff.id, () => res.redirect(safeNext(req.body.next)));
});

router.post('/logout', async (req, res) => {
  req.session.regenerate(() => res.redirect('/admin/login'));
});

module.exports = router;
