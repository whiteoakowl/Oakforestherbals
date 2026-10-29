'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./session-store');
const mw = require('./middleware');
const { UPLOAD_DIR } = require('./uploads');
const fs = require('node:fs');
const { token } = require('./utils');

require('./seed').ensureBase();

const app = express();
const ROOT = path.join(__dirname, '..');

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(mw.securityHeaders);
app.use('/public', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
app.use('/images', express.static(path.join(ROOT, 'public', 'images'), { maxAge: '1d' }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  // Uploaded SVGs could carry script; force them to download-safe rendering.
  setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"),
}));

app.use('/webhooks', require('./routes/webhooks'));

// Without SESSION_SECRET, keep a generated secret next to the database so logins survive restarts.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(process.env.DB_PATH || path.join(ROOT, 'data', 'store.db')), '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, token(32), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new SqliteStore(),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  name: 'store.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
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
  const status = err.status || 500;
  res.status(status);
  if (req.originalUrl.startsWith('/admin')) {
    return res.render('admin/error', { title: 'Something went wrong', message: status === 500 ? 'An unexpected error occurred.' : err.message });
  }
  res.render('store/404', { title: 'Something went wrong', message: status === 500 ? 'An unexpected error occurred.' : err.message });
});

module.exports = app;
