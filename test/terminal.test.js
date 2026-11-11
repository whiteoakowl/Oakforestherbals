'use strict';
// Point of sale with a Stripe card reader (Stripe simulated), and gift cards at the counter.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all } = require('../src/db');
const settings = require('../src/settings');

let ctx;
let owner;
let variant;
const realFetch = global.fetch;
const intents = new Map();
const calls = [];
let next = 1;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.stripe.com/')) return realFetch(url, opts);
  const path = u.replace('https://api.stripe.com/v1', '');
  const body = opts.body ? Object.fromEntries(new URLSearchParams(String(opts.body))) : {};
  calls.push({ method: opts.method, path, body });
  let json = {};
  if (path.startsWith('/terminal/readers?')) json = { data: [{ id: 'tmr_test1', label: 'Front counter', device_type: 'simulated_wisepos_e', status: 'online' }] };
  else if (path === '/payment_intents') { const id = `pi_${next++}`; intents.set(id, { id, amount: Number(body.amount), status: 'requires_payment_method' }); json = intents.get(id); }
  else if (/^\/payment_intents\/[^/]+$/.test(path)) json = intents.get(path.split('/')[2]);
  else if (/^\/payment_intents\/[^/]+\/cancel$/.test(path)) { const pi = intents.get(path.split('/')[2]); pi.status = 'canceled'; json = pi; }
  else if (path.endsWith('/process_payment_intent')) { const pi = intents.get(body.payment_intent); delete pi.last_payment_error; json = { id: 'tmr_test1' }; }
  else if (path.startsWith('/test_helpers/terminal/readers/')) {
    const pi = [...intents.values()].find((p) => p.status === 'requires_payment_method');
    if (globalThis.declineNext) { pi.last_payment_error = { message: 'Your card was declined.' }; globalThis.declineNext = false; } else Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: `ch_${pi.id}` });
    json = { id: 'tmr_test1' };
  } else if (path.endsWith('/cancel_action')) json = { id: 'tmr_test1' };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

before(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await settings.save('payments', { stripe_enabled: true });
  variant = await get("SELECT v.* FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'lemon-balm-tincture'");
});
after(() => { global.fetch = realFetch; delete process.env.STRIPE_SECRET_KEY; return ctx.close(); });

test('the owner picks a registered reader; the card reader option then appears at the counter', async () => {
  let page = await owner.get('/admin/pos');
  assert.doesNotMatch(page.text, /Card reader \(Stripe\)/);
  page = await owner.get('/admin/pos/readers');
  assert.match(page.text, /Front counter/);
  await owner.post('/admin/pos/readers', { reader: 'tmr_test1' }, '/admin/pos/readers');
  assert.equal(settings.load('pos').terminal_reader, 'tmr_test1');
  await owner.post('/admin/pos/add', { variant_id: String(variant.id), quantity: '2' }, '/admin/pos');
  page = await owner.get('/admin/pos');
  assert.match(page.text, /Card reader \(Stripe\)/);
});

test('a reader payment: declined, retried, then paid — the order is created only once paid', async () => {
  const before = (await get('SELECT COUNT(*) AS n FROM orders')).n;
  let res = await owner.post('/admin/pos/complete', { method: 'terminal' }, '/admin/pos');
  assert.equal(res.location, '/admin/pos/terminal');
  const create = calls.find((c) => c.path === '/payment_intents');
  assert.equal(create.body['payment_method_types[0]'], 'card_present');
  assert.ok(calls.some((c) => c.path === '/terminal/readers/tmr_test1/process_payment_intent'));
  let page = await owner.get('/admin/pos/terminal');
  assert.match(page.text, /Waiting for the customer/);
  assert.match(page.text, /Simulate a tap/);
  // The sale can't be changed while the reader waits.
  res = await owner.post('/admin/pos/add', { variant_id: String(variant.id), quantity: '1' }, '/admin/pos/terminal');
  assert.equal(res.location, '/admin/pos/terminal');
  assert.equal((await owner.get('/admin/pos')).location, '/admin/pos/terminal');
  // Declined, then another card works.
  globalThis.declineNext = true;
  await owner.post('/admin/pos/terminal/simulate', {}, '/admin/pos/terminal');
  page = await owner.get('/admin/pos/terminal');
  assert.match(page.text, /Your card was declined/);
  assert.equal((await get('SELECT COUNT(*) AS n FROM orders')).n, before, 'nothing recorded yet');
  await owner.post('/admin/pos/terminal/retry', {}, '/admin/pos/terminal');
  await owner.post('/admin/pos/terminal/simulate', {}, '/admin/pos/terminal');
  res = await owner.get('/admin/pos/terminal');
  assert.match(res.location, /^\/admin\/pos\/receipt\/\d+$/);
  const order = await get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  assert.equal(order.source, 'pos');
  assert.equal(order.financial_status, 'paid');
  assert.equal(order.payment_method, 'Card reader (Stripe)');
  assert.match(order.payment_ref, /^ch_pi_/);
  assert.equal(order.total, create.body.amount * 1);
  assert.equal((await get('SELECT COUNT(*) AS n FROM orders')).n, before + 1);
  // The sale is finished and the counter is free again.
  assert.equal((await owner.get('/admin/pos')).status, 200);
});

test('cancelling a reader payment leaves the sale open and records nothing', async () => {
  await owner.post('/admin/pos/add', { variant_id: String(variant.id), quantity: '1' }, '/admin/pos');
  const before = (await get('SELECT COUNT(*) AS n FROM orders')).n;
  await owner.post('/admin/pos/complete', { method: 'terminal' }, '/admin/pos');
  await owner.post('/admin/pos/terminal/cancel', {}, '/admin/pos/terminal');
  const pi = [...intents.values()].at(-1);
  assert.equal(pi.status, 'canceled');
  assert.equal((await get('SELECT COUNT(*) AS n FROM orders')).n, before);
  assert.match((await owner.get('/admin/pos')).text, /Lemon Balm Tincture/);
  await owner.post('/admin/pos/clear', {}, '/admin/pos');
});

test('a gift card pays at the counter, alone or with cash', async () => {
  const gc = require('../src/giftcards');
  const small = await gc.create({ value: 1000, createdBy: 'test' });
  await owner.post('/admin/pos/add', { variant_id: String(variant.id), quantity: '1' }, '/admin/pos');
  await owner.post('/admin/pos/gift-card', { code: small.code }, '/admin/pos');
  let page = await owner.get('/admin/pos');
  assert.match(page.text, /To pay/);
  const total = Number(page.text.match(/<strong>Total<\/strong><\/td><td class="num"><strong>\$([\d.]+)/)[1].replace('.', ''));
  // Cash must cover what's left after the card.
  let res = await owner.post('/admin/pos/complete', { method: 'cash', tendered: '1.00' }, '/admin/pos');
  assert.equal(res.location, '/admin/pos');
  res = await owner.post('/admin/pos/complete', { method: 'cash', tendered: '50.00' }, '/admin/pos');
  assert.match(res.location, /receipt/);
  const order = await get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  assert.equal(order.total, total);
  assert.equal(order.gift_card_total, 1000);
  assert.deepEqual((await all('SELECT method, amount FROM payments WHERE order_id = ? ORDER BY id', order.id)).map((p) => [p.method, p.amount]), [['Cash (in person)', total - 1000], ['Gift card', 1000]]);
  // A card big enough needs no other payment.
  const big = await gc.create({ value: 100000, createdBy: 'test' });
  await owner.post('/admin/pos/add', { variant_id: String(variant.id), quantity: '1' }, '/admin/pos');
  await owner.post('/admin/pos/gift-card', { code: big.code }, '/admin/pos');
  assert.match((await owner.get('/admin/pos')).text, /The gift card covers this sale/);
  res = await owner.post('/admin/pos/complete', {}, '/admin/pos');
  assert.match(res.location, /receipt/);
  assert.equal((await get('SELECT payment_method FROM orders ORDER BY id DESC LIMIT 1')).payment_method, 'Gift card');
});
