'use strict';
// Boots the app on a throwaway database and provides a cookie-aware HTTP client.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.UPLOAD_DIR = dir;
process.env.ADMIN_EMAIL = 'owner@example.com';
process.env.ADMIN_PASSWORD = 'password123';

const { main: seed } = require('../src/seed');
const origLog = console.log;
console.log = () => {};
seed({ orders: true });
console.log = origLog;

const app = require('../src/app');

async function start() {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }

  async request(method, url, body) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }

  get(url) { return this.request('GET', url); }

  // Fetches a page first so the session has a CSRF token, then posts with it.
  async post(url, body = {}, from = '/') {
    const page = await this.get(from);
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    return this.request('POST', url, { ...body, _csrf: m ? m[1] : '' });
  }

  async follow(res) {
    let r = res;
    for (let i = 0; i < 5 && r.location; i++) r = await this.get(r.location);
    return r;
  }
}

module.exports = { start, Client };
