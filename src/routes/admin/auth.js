'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../../db');
const settings = require('../../settings');
const { flash, throttle } = require('../../middleware');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/admin') ? n : '/admin');

function signIn(req, staffId, done) {
  const { cart } = req.session;
  req.session.regenerate(() => {
    Object.assign(req.session, { cart, staffId });
    run("UPDATE staff SET last_login_at = datetime('now') WHERE id = ?", staffId);
    done();
  });
}

// First-run wizard: creates the owner account when no staff exist yet.
router.get('/setup', (req, res) => {
  if (get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'Set up your store', bare: true });
});

router.post('/setup', (req, res) => {
  if (get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  const { name = '', email = '', password = '', store_name = '' } = req.body;
  if (!email.includes('@') || password.length < 8 || !name.trim()) {
    flash(req, 'error', 'Enter your name, a valid email and a password of at least 8 characters.');
    return res.redirect('/admin/setup');
  }
  const id = Number(run("INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')",
    email.trim(), name.trim(), bcrypt.hashSync(password, 10)).lastInsertRowid);
  if (store_name.trim()) settings.save('store', { name: store_name.trim(), email: email.trim() });
  signIn(req, id, () => res.redirect('/admin'));
});

router.get('/login', (req, res) => {
  if (res.locals.staff) return res.redirect('/admin');
  if (!get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/setup');
  res.render('admin/login', { title: 'Log in', bare: true, next: safeNext(req.query.next) });
});

router.post('/login', throttle('staff'), (req, res) => {
  const staff = get('SELECT * FROM staff WHERE email = ?', String(req.body.email || '').trim());
  if (!staff || !bcrypt.compareSync(String(req.body.password || ''), staff.password_hash)) {
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect(`/admin/login?next=${encodeURIComponent(safeNext(req.body.next))}`);
  }
  signIn(req, staff.id, () => res.redirect(safeNext(req.body.next)));
});

router.post('/logout', (req, res) => {
  req.session.regenerate(() => res.redirect('/admin/login'));
});

module.exports = router;
