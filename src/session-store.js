'use strict';
// express-session store backed by the Postgres sessions table.
const session = require('express-session');
const { get, run } = require('./db');

const DAY = 24 * 60 * 60 * 1000;

class PgStore extends session.Store {
  get(sid, cb) {
    get('SELECT data, expires FROM sessions WHERE sid = ?', sid)
      .then((row) => cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null), cb);
  }

  set(sid, sess, cb = () => {}) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY;
    run('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
      sid, JSON.stringify(sess), expires)
      // Occasionally sweep expired sessions; there is no long-lived process to run a timer in.
      .then(() => (Math.random() < 0.01 ? run('DELETE FROM sessions WHERE expires < ?', Date.now()) : null))
      .then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb(null), cb);
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = PgStore;
