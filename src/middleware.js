'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');
const settings = require('./settings');
const utils = require('./utils');
const catalog = require('./catalog');
const { themeColors } = require('./colors');
const permissions = require('./permissions');
const audit = require('./audit');

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

// Fresh settings for this request (another serverless instance may have changed them).
async function loadSettings(req, res, next) {
  await settings.refresh();
  next();
}

async function locals(req, res, next) {
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
  res.locals.toDateTimeInput = utils.toDateTimeInput;
  res.locals.stripHtml = utils.stripHtml;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.cartCount = (req.session.cart || []).reduce((s, i) => s + i.quantity, 0);
  const [staff, customer, menus] = await Promise.all([
    req.session.staffId ? get('SELECT id, email, name, role FROM staff WHERE id = ?', req.session.staffId) : null,
    req.session.customerId ? get('SELECT * FROM customers WHERE id = ?', req.session.customerId) : null,
    catalog.menus(),
  ]);
  if (staff) staff.permissions = await permissions.forRole(staff.role);
  Object.assign(res.locals, { staff: staff || null, customer: customer || null });
  res.locals.can = (perm) => Boolean(staff && staff.permissions.has(perm));
  res.locals.menu = (handle) => menus[handle] || [];
  next();
}

async function requireStaff(req, res, next) {
  if (!res.locals.staff) {
    if (!await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/setup');
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireOwner(req, res, next) {
  if (res.locals.staff.role !== 'owner') return denied(req, res, 'owner');
  next();
}

function denied(req, res, perm) {
  audit.record(req, 'access.denied', { details: { permission: perm, method: req.method, path: req.originalUrl.split('?')[0] } });
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include access to this area. Ask the store owner if you need it.' });
}

// Gates a router: reads (GET/HEAD) need viewPerm or managePerm; everything else needs managePerm.
// With one argument, that permission covers both.
function requirePermission(viewPerm, managePerm = viewPerm) {
  return (req, res, next) => {
    const reading = req.method === 'GET' || req.method === 'HEAD';
    const ok = reading ? (res.locals.can(viewPerm) || res.locals.can(managePerm)) : res.locals.can(managePerm);
    if (!ok) return denied(req, res, reading ? viewPerm : managePerm);
    next();
  };
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
async function trackView(req, res, next) {
  if (req.method === 'GET' && !res.locals.staff && req.accepts('html')) {
    if (!req.session.visitor) req.session.visitor = utils.token(8);
    const day = new Date().toISOString().slice(0, 10);
    await run('INSERT INTO page_views (day, visitor) VALUES (?, ?) ON CONFLICT (day, visitor) DO UPDATE SET views = page_views.views + 1', day, req.session.visitor);
  }
  next();
}

// Login/registration throttle: 10 attempts per 15 minutes per IP and scope. Stored in Postgres so
// every serverless instance sees the same count. Fails open (with a log line) if the table is
// unreachable, so a database hiccup can't lock everyone out.
const THROTTLE_WINDOW = 15 * 60 * 1000;
const THROTTLE_LIMIT = 10;
async function hitThrottle(key, now = Date.now()) {
  const row = await get(`INSERT INTO login_attempts (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN login_attempts.window_start < ? THEN 1 ELSE login_attempts.count + 1 END,
      window_start = CASE WHEN login_attempts.window_start < ? THEN EXCLUDED.window_start ELSE login_attempts.window_start END
    RETURNING count`, key, now, now - THROTTLE_WINDOW, now - THROTTLE_WINDOW);
  if (Math.random() < 0.02) await run('DELETE FROM login_attempts WHERE window_start < ?', now - THROTTLE_WINDOW);
  return row.count;
}

function throttle(scope) {
  return async (req, res, next) => {
    if (req.method !== 'POST') return next();
    let count = 0;
    try {
      count = await hitThrottle(`${scope}:${req.ip}`);
    } catch (err) {
      console.error('throttle unavailable', err.message);
    }
    if (count > THROTTLE_LIMIT) return res.status(429).send('Too many attempts. Please wait a few minutes and try again.');
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
  csrfGuard, verifyCsrf, flash, loadSettings, locals, requireStaff, requireOwner, requirePermission, requireCustomer,
  storefrontPassword, trackView, throttle, securityHeaders,
};
