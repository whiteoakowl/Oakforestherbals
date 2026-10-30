'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const PgStore = require('./session-store');
const mw = require('./middleware');
const storage = require('./storage');
const { ensureBase } = require('./seed');

const app = express();
const ROOT = path.join(__dirname, '..');

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(mw.securityHeaders);
// On Netlify these are served by the CDN before requests reach the function.
app.use('/public', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
app.use('/images', express.static(path.join(ROOT, 'public', 'images'), { maxAge: '1d' }));
if (!storage.useSupabase) {
  app.use('/uploads', express.static(storage.UPLOAD_DIR, {
    maxAge: '7d',
    // Uploaded SVGs could carry script; keep them from running on this origin.
    setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"),
  }));
}

// Tables and default menus exist before the first request is handled.
let baseReady;
app.use(async (req, res, next) => {
  baseReady = baseReady || ensureBase();
  await baseReady;
  next();
});

app.use('/webhooks', require('./routes/webhooks'));

// SESSION_SECRET if set; otherwise derived from DATABASE_URL (already a secret), or a local file.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.DATABASE_URL) return crypto.createHash('sha256').update(`session:${process.env.DATABASE_URL}`).digest('hex');
  const file = path.join(ROOT, 'data', '.session-secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new PgStore(),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  name: 'store.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // secure whenever the request arrived over HTTPS
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
app.use(mw.loadSettings);
app.use(mw.locals);
app.use(mw.csrfGuard);

app.use('/admin', require('./routes/admin'));
app.use(mw.storefrontPassword);
app.use(mw.trackView);
app.use('/account', require('./routes/account'));
app.use('/checkout', require('./routes/checkout'));
app.use('/', require('./routes/store'));

app.use((req, res) => {
  res.status(404).render('store/404', { title: 'Page not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? `That file is too large. Images must be under ${Math.round(storage.MAX_BYTES / 1024 / 1024)} MB.`
    : status === 500 ? 'An unexpected error occurred.' : err.message;
  res.status(status);
  if (!res.locals.store) return res.send(message);
  if (req.originalUrl.startsWith('/admin')) return res.render('admin/error', { title: 'Something went wrong', message });
  res.render('store/404', { title: 'Something went wrong', message });
});

module.exports = app;
