'use strict';
// Customer accounts: sign up, log in, order history, addresses and password reset.
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../db');
const settings = require('../settings');
const mailer = require('../mailer');
const orders = require('../orders');
const { flash, requireCustomer, throttle } = require('../middleware');
const { token, toInt } = require('../utils');
const { COUNTRIES } = require('../countries');

const router = express.Router();

// New session id on login (prevents fixation) while keeping the shopper's cart.
function signIn(req, customerId, done) {
  const { cart, cartNote } = req.session;
  req.session.regenerate(() => {
    Object.assign(req.session, { cart, cartNote, customerId });
    done();
  });
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

router.use((req, res, next) => {
  if (settings.load('checkout').customer_accounts === 'disabled') return res.redirect('/');
  next();
});

router.get('/login', (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  res.render('store/account/login', { title: 'Log in', next: safeNext(req.query.next) });
});

router.post('/login', throttle('customer'), (req, res) => {
  const email = String(req.body.email || '').trim();
  const customer = get('SELECT * FROM customers WHERE email = ?', email);
  if (!customer || !customer.password_hash || !bcrypt.compareSync(String(req.body.password || ''), customer.password_hash)) {
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect(`/account/login?next=${encodeURIComponent(safeNext(req.body.next))}`);
  }
  signIn(req, customer.id, () => res.redirect(safeNext(req.body.next)));
});

router.get('/register', (req, res) => res.render('store/account/register', { title: 'Create account' }));

router.post('/register', throttle('register'), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    flash(req, 'error', 'Enter a valid email and a password of at least 8 characters.');
    return res.redirect('/account/register');
  }
  const existing = get('SELECT * FROM customers WHERE email = ?', email);
  if (existing && existing.password_hash) {
    flash(req, 'error', 'An account with this email already exists. Log in or reset your password.');
    return res.redirect('/account/login');
  }
  const hash = bcrypt.hashSync(password, 10);
  const first = String(req.body.first_name || '').trim();
  const last = String(req.body.last_name || '').trim();
  const marketing = req.body.accepts_marketing ? 1 : 0;
  let id;
  if (existing) {
    // Guest checkouts already created a customer record; claim it.
    run('UPDATE customers SET password_hash = ?, first_name = COALESCE(NULLIF(?, \'\'), first_name), last_name = COALESCE(NULLIF(?, \'\'), last_name), accepts_marketing = MAX(accepts_marketing, ?) WHERE id = ?',
      hash, first, last, marketing, existing.id);
    id = existing.id;
  } else {
    id = Number(run('INSERT INTO customers (email, first_name, last_name, password_hash, accepts_marketing) VALUES (?, ?, ?, ?, ?)',
      email, first, last, hash, marketing).lastInsertRowid);
  }
  mailer.notify('customer_welcome', email, `Welcome to ${res.locals.store.name}`, 'welcome', { first_name: first });
  signIn(req, id, () => res.redirect('/account'));
});

router.post('/logout', (req, res) => {
  const cart = req.session.cart;
  req.session.regenerate(() => {
    req.session.cart = cart;
    res.redirect('/');
  });
});

router.get('/recover', (req, res) => res.render('store/account/recover', { title: 'Reset your password' }));

router.post('/recover', throttle('recover'), (req, res) => {
  const customer = get('SELECT * FROM customers WHERE email = ?', String(req.body.email || '').trim());
  if (customer) {
    const t = token(24);
    run('INSERT INTO password_resets (token, customer_id, expires_at) VALUES (?, ?, ?)', t, customer.id, Date.now() + 60 * 60 * 1000);
    const url = `${req.protocol}://${req.get('host')}/account/reset/${t}`;
    mailer.notify(null, customer.email, 'Reset your password', 'password-reset', { url });
  }
  flash(req, 'success', 'If that email has an account, we sent a link to reset your password.');
  res.redirect('/account/login');
});

function validReset(t) {
  return get('SELECT * FROM password_resets WHERE token = ? AND expires_at > ?', t, Date.now());
}

router.get('/reset/:token', (req, res) => {
  if (!validReset(req.params.token)) {
    flash(req, 'error', 'This reset link is invalid or has expired.');
    return res.redirect('/account/recover');
  }
  res.render('store/account/reset', { title: 'Choose a new password', token: req.params.token });
});

router.post('/reset/:token', (req, res) => {
  const reset = validReset(req.params.token);
  const password = String(req.body.password || '');
  if (!reset) return res.redirect('/account/recover');
  if (password.length < 8) {
    flash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect(`/account/reset/${req.params.token}`);
  }
  run('UPDATE customers SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), reset.customer_id);
  run('DELETE FROM password_resets WHERE customer_id = ?', reset.customer_id);
  signIn(req, reset.customer_id, () => res.redirect('/account'));
});

router.use(requireCustomer);

router.get('/', (req, res) => {
  const list = all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', res.locals.customer.id)
    .map((o) => ({ ...o, name: orders.orderName(o) }));
  const address = get('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id LIMIT 1', res.locals.customer.id);
  res.render('store/account/index', { title: 'My account', orders: list, address });
});

router.post('/profile', (req, res) => {
  run('UPDATE customers SET first_name = ?, last_name = ?, phone = ?, accepts_marketing = ? WHERE id = ?',
    String(req.body.first_name || ''), String(req.body.last_name || ''), String(req.body.phone || ''),
    req.body.accepts_marketing ? 1 : 0, res.locals.customer.id);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/account');
});

router.get('/orders/:number', (req, res, next) => {
  const row = get('SELECT id FROM orders WHERE number = ? AND customer_id = ?', toInt(req.params.number), res.locals.customer.id);
  if (!row) return next();
  const order = orders.orderById(row.id);
  res.render('store/account/order', { title: `Order ${order.name}`, order });
});

/* ---------- Addresses ---------- */

const FIELDS = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];

router.get('/addresses', (req, res) => {
  const addresses = all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id', res.locals.customer.id);
  res.render('store/account/addresses', { title: 'Addresses', addresses, COUNTRIES });
});

router.post('/addresses', (req, res) => {
  const cid = res.locals.customer.id;
  const values = FIELDS.map((f) => String(req.body[f] || '').trim());
  const id = toInt(req.body.id);
  const makeDefault = req.body.is_default || !get('SELECT 1 FROM addresses WHERE customer_id = ?', cid);
  if (makeDefault) run('UPDATE addresses SET is_default = 0 WHERE customer_id = ?', cid);
  if (id) {
    run(`UPDATE addresses SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}${makeDefault ? ', is_default = 1' : ''} WHERE id = ? AND customer_id = ?`, ...values, id, cid);
  } else {
    run(`INSERT INTO addresses (customer_id, ${FIELDS.join(', ')}, is_default) VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?)`, cid, ...values, makeDefault ? 1 : 0);
  }
  flash(req, 'success', 'Address saved.');
  res.redirect('/account/addresses');
});

router.post('/addresses/:id/delete', (req, res) => {
  run('DELETE FROM addresses WHERE id = ? AND customer_id = ?', toInt(req.params.id), res.locals.customer.id);
  flash(req, 'success', 'Address removed.');
  res.redirect('/account/addresses');
});

module.exports = router;
