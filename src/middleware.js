'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');
const settings = require('./settings');
const utils = require('./utils');
const catalog = require('./catalog');
const { themeColors } = require('./colors');

// CSRF: one token per session, required on every non-GET request.
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = utils.token(16);
  return req.session.csrf;
}

function verifyCsrf(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  const ok = sent.length === expected.length && expected.length > 0
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return res.status(403).send('Your session expired. Go back, refresh the page and try again.');
  next();
}

// Multipart forms are verified inside their route, after multer has parsed the body.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  return verifyCsrf(req, res, next);
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function locals(req, res, next) {
  const store = settings.load('store');
  res.locals.store = store;
  res.locals.theme = settings.load('theme');
  res.locals.themeColors = themeColors(res.locals.theme);
  res.locals.seoSettings = settings.load('seo');
  res.locals.settingsAccounts = settings.load('checkout').customer_accounts;
  res.locals.csrf = csrfToken(req);
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.money = (cents) => utils.formatMoney(cents, store.currency_symbol);
  res.locals.formatDate = utils.formatDate;
  res.locals.centsToInput = utils.centsToInput;
  res.locals.stripHtml = utils.stripHtml;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.staff = req.session.staffId ? get('SELECT id, email, name, role FROM staff WHERE id = ?', req.session.staffId) : null;
  res.locals.customer = req.session.customerId ? get('SELECT * FROM customers WHERE id = ?', req.session.customerId) : null;
  res.locals.cartCount = (req.session.cart || []).reduce((s, i) => s + i.quantity, 0);
  res.locals.menu = catalog.menu;
  next();
}

function requireStaff(req, res, next) {
  if (!res.locals.staff) {
    if (!get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/setup');
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireOwner(req, res, next) {
  if (res.locals.staff.role !== 'owner') {
    return res.status(403).render('admin/error', { title: 'Permission required', message: 'Only the store owner can manage these settings.' });
  }
  next();
}

function requireCustomer(req, res, next) {
  if (!res.locals.customer) return res.redirect(`/account/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

// Store password page: blocks the storefront for non-staff until the owner opens the store.
function storefrontPassword(req, res, next) {
  const store = res.locals.store;
  if (!store.password_enabled || res.locals.staff || req.session.storefrontUnlocked) return next();
  if (req.path === '/password') return next();
  return res.redirect('/password');
}

// Counts unique visitors per day for the analytics dashboard.
function trackView(req, res, next) {
  if (req.method === 'GET' && !res.locals.staff && req.accepts('html')) {
    if (!req.session.visitor) req.session.visitor = utils.token(8);
    const day = new Date().toISOString().slice(0, 10);
    run('INSERT INTO page_views (day, visitor) VALUES (?, ?) ON CONFLICT(day, visitor) DO UPDATE SET views = views + 1', day, req.session.visitor);
  }
  next();
}

// Naive in-memory login throttle: 10 attempts per 15 minutes per IP + scope.
const attempts = new Map();
function throttle(scope) {
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = `${scope}:${req.ip}`;
    const now = Date.now();
    const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60 * 1000; }
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > 10) return res.status(429).send('Too many attempts. Please wait a few minutes and try again.');
    next();
  };
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
}

module.exports = {
  csrfGuard, verifyCsrf, flash, locals, requireStaff, requireOwner, requireCustomer,
  storefrontPassword, trackView, throttle, securityHeaders,
};
