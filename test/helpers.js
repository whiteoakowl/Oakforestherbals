'use strict';
// Boots the app on a throwaway in-memory Postgres and provides a cookie-aware HTTP client.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
process.env.UPLOAD_DIR = dir;
process.env.ADMIN_EMAIL = 'owner@example.com';
process.env.ADMIN_PASSWORD = 'password123';
delete process.env.SUPABASE_URL;

// By default tests use an in-memory embedded Postgres. Set TEST_DATABASE_URL to a Postgres
// server to run them against the real thing instead (a fresh database per test file).
if (process.env.TEST_DATABASE_URL) {
  const name = `store_test_${process.pid}`;
  execFileSync('psql', [process.env.TEST_DATABASE_URL, '-qc', `CREATE DATABASE ${name}`]);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
} else {
  delete process.env.DATABASE_URL;
  process.env.DB_PATH = 'memory://';
}

const { main: seed } = require('../src/seed');
const app = require('../src/app');

async function start() {
  const origLog = console.log;
  console.log = () => {};
  await seed({ orders: true });
  console.log = origLog;
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((r) => server.close(r));
    await require('../src/db').end();
  };
  return { server, base, close };
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
}

module.exports = { start, Client };
