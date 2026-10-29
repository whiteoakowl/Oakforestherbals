'use strict';
// express-session store backed by the SQLite sessions table.
const session = require('express-session');
const { get, run } = require('./db');

const DAY = 24 * 60 * 60 * 1000;

class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => run('DELETE FROM sessions WHERE expires < ?', Date.now()), 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY;
      run('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
        sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try { run('DELETE FROM sessions WHERE sid = ?', sid); cb && cb(null); } catch (err) { cb && cb(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = SqliteStore;
