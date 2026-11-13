'use strict';
// Installable app: manifests, service worker, offline page and install buttons.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const settings = require('../src/settings');

let ctx;

before(async () => { ctx = await start(); });
after(async () => { await ctx.close(); });

test('the storefront manifest uses the store name, theme colours and app icons', async () => {
  const res = await fetch(`${ctx.base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.equal(m.name, settings.load('store').name);
  assert.equal(m.display, 'standalone');
  assert.equal(m.scope, '/');
  assert.equal(m.theme_color, settings.load('theme').color_primary);
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
  for (const icon of m.icons) {
    const img = await fetch(ctx.base + icon.src);
    assert.equal(img.status, 200, icon.src);
    assert.match(img.headers.get('content-type'), /image\/png/);
  }
});

test('the admin manifest is public (so the login page can install) and opens the admin', async () => {
  const res = await fetch(`${ctx.base}/admin/manifest.webmanifest`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.start_url, '/admin');
  assert.equal(m.scope, '/admin');
});

test('the manifest stays reachable while the storefront is password protected', async () => {
  const store = settings.load('store');
  await settings.save('store', { ...store, password_enabled: true });
  try {
    const res = await fetch(`${ctx.base}/manifest.webmanifest`, { redirect: 'manual' });
    assert.equal(res.status, 200);
  } finally {
    await settings.save('store', store);
  }
});

test('the service worker, offline page and Apple touch icon are served from the site root', async () => {
  const sw = await fetch(`${ctx.base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const offline = await fetch(`${ctx.base}/offline.html`);
  assert.equal(offline.status, 200);
  assert.match(await offline.text(), /You're offline/);
  const apple = await fetch(`${ctx.base}/apple-touch-icon.png`);
  assert.equal(apple.status, 200);
});

test('storefront and admin pages link their manifest and carry a hidden install button', async () => {
  const shopper = new Client(ctx.base);
  const home = await shopper.get('/');
  assert.match(home.text, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(home.text, /apple-touch-icon/);
  assert.match(home.text, /data-install-app hidden/);
  assert.match(home.text, /\/public\/js\/pwa.js/);

  const login = await new Client(ctx.base).get('/admin/login');
  assert.match(login.text, /<link rel="manifest" href="\/admin\/manifest.webmanifest">/);

  const owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  const dash = await owner.get('/admin');
  assert.match(dash.text, /data-install-app hidden>Install app/);
});
