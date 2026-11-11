'use strict';
// Subscribe & save (with Stripe simulated) and abandoned cart reminders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, Client } = require('./helpers');
const { get, all, run, insert } = require('../src/db');
const settings = require('../src/settings');
const abandoned = require('../src/abandoned');

let ctx;
let owner;
const ids = {};
const stripeCalls = [];
const realFetch = global.fetch;
const SECRET = 'whsec_test';

// Stands in for api.stripe.com; everything else goes to the real fetch (the test server).
const stripeSubs = new Map();
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.stripe.com/')) return realFetch(url, opts);
  const path = u.replace('https://api.stripe.com/v1', '');
  const body = opts.body ? Object.fromEntries(new URLSearchParams(String(opts.body))) : {};
  stripeCalls.push({ method: opts.method, path, body });
  let json = {};
  if (path === '/checkout/sessions') json = { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/cs_test_1' };
  else if (path.startsWith('/subscriptions/')) {
    const id = decodeURIComponent(path.split('/')[2]);
    const sub = stripeSubs.get(id);
    if (opts.method === 'POST') sub.cancel_at_period_end = body.cancel_at_period_end === 'true';
    if (opts.method === 'DELETE') sub.status = 'canceled';
    json = sub;
  } else if (path === '/billing_portal/sessions') json = { url: 'https://billing.stripe.test/p/1' };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

function signed(event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return realFetch(`${ctx.base}/webhooks/stripe`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } });
}

before(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await settings.save('payments', { stripe_enabled: true });
  await owner.post('/admin/settings/store-features', { reviews_enabled: '1', subscriptions_enabled: '1', subscription_shipping: '5.00', max_downloads: '5', expiry_days: '30', abandoned_delay_hours: '4', abandoned_require_consent: '1' }, '/admin/settings/store-features');
  const pid = await insert("INSERT INTO products (title, handle, status, subscription_interval, subscription_interval_count, subscription_discount) VALUES ('Daily Tea', 'daily-tea', 'active', 'month', 1, 10)");
  ids.variant = await insert('INSERT INTO variants (product_id, price, inventory_qty, track_inventory) VALUES (?, 2000, 1, 1)', pid);
  ids.product = pid;
});
after(() => { global.fetch = realFetch; delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; return ctx.close(); });

test('the product page offers subscribe & save; subscribing needs an account and starts Stripe Checkout', async () => {
  const guest = new Client(ctx.base);
  const page = await guest.get('/products/daily-tea');
  assert.match(page.text, /Subscribe &amp; save 10%/);
  assert.match(page.text, /every month/);
  assert.match(page.text, /\$18\.00 each/);
  let res = await guest.post('/subscriptions/start', { variant_id: String(ids.variant), quantity: '2' }, '/products/daily-tea');
  assert.match(res.location, /^\/account\/login\?next=/);

  const c = new Client(ctx.base);
  await c.post('/account/register', { first_name: 'Sky', last_name: 'Ash', email: 'sky@example.com', password: 'password123' }, '/account/register');
  ids.customer = (await get("SELECT id FROM customers WHERE email = 'sky@example.com'")).id;
  res = await c.post('/subscriptions/start', { variant_id: String(ids.variant), quantity: '2' }, '/products/daily-tea');
  assert.equal(res.status, 303);
  assert.equal(res.location, 'https://checkout.stripe.test/c/cs_test_1');
  const call = stripeCalls.find((x) => x.path === '/checkout/sessions');
  assert.equal(call.body.mode, 'subscription');
  assert.equal(call.body['line_items[0][price_data][unit_amount]'], '1800');
  assert.equal(call.body['line_items[0][quantity]'], '2');
  assert.equal(call.body['line_items[0][price_data][recurring][interval]'], 'month');
  assert.equal(call.body['line_items[1][price_data][unit_amount]'], '500', 'delivery charge');
  assert.equal(call.body['subscription_data[metadata][variant_id]'], String(ids.variant));
  assert.equal(call.body['shipping_address_collection[allowed_countries][0]'], 'US');
  ids.client = c;
});

test('each paid Stripe invoice becomes one paid order, even when events repeat or arrive out of order', async () => {
  const now = Math.floor(Date.now() / 1000);
  stripeSubs.set('sub_123', { id: 'sub_123', status: 'active', customer: 'cus_9', cancel_at_period_end: false, current_period_end: now + 30 * 86400,
    metadata: { customer_id: String(ids.customer), variant_id: String(ids.variant), quantity: '2', price: '1800', shipping_price: '500' },
    items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] } });
  const invoice = (id) => ({ id, number: id.toUpperCase(), subscription: 'sub_123', customer: 'cus_9', customer_email: 'sky@example.com', amount_paid: 4100, payment_intent: `pi_${id}`,
    customer_shipping: { name: 'Sky Ash', address: { line1: '9 Pine Rd', city: 'Salem', state: 'OR', postal_code: '97301', country: 'US' } } });
  // invoice.paid can arrive before checkout.session.completed.
  let r = await signed({ type: 'invoice.paid', data: { object: invoice('in_1') } });
  assert.equal(r.status, 200);
  const sub = await get("SELECT * FROM subscriptions WHERE stripe_subscription_id = 'sub_123'");
  assert.equal(sub.status, 'active');
  assert.equal(sub.customer_id, ids.customer);
  let orders = await all('SELECT * FROM orders WHERE subscription_id = ?', sub.id);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.financial_status, 'paid');
  assert.equal(o.source, 'subscription');
  assert.equal(o.subtotal, 3600);
  assert.equal(o.shipping_total, 500);
  assert.equal(o.total, 4100);
  assert.equal(JSON.parse(o.shipping_address).address1, '9 Pine Rd');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', ids.variant)).inventory_qty, -1, 'a paid renewal is never refused for stock');
  assert.ok(await get("SELECT 1 FROM notifications WHERE title LIKE 'Not enough Daily Tea%'"), 'staff told about the shortfall');
  assert.equal((await get('SELECT SUM(amount) AS n FROM payments WHERE order_id = ?', o.id)).n, 4100);
  // Repeat delivery of the same event: nothing new.
  await signed({ type: 'invoice.paid', data: { object: invoice('in_1') } });
  await signed({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', mode: 'subscription', subscription: 'sub_123', payment_status: 'paid', client_reference_id: `customer-${ids.customer}` } } });
  assert.equal((await all('SELECT id FROM orders WHERE subscription_id = ?', sub.id)).length, 1);
  // Next month's renewal.
  await signed({ type: 'invoice.paid', data: { object: invoice('in_2') } });
  orders = await all('SELECT id FROM orders WHERE subscription_id = ?', sub.id);
  assert.equal(orders.length, 2);
  // Forged events are refused.
  const forged = await realFetch(`${ctx.base}/webhooks/stripe`, { method: 'POST', body: JSON.stringify({ type: 'invoice.paid', data: { object: invoice('in_x') } }), headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' } });
  assert.equal(forged.status, 400);
  ids.sub = sub.id;
});

test('customers see and cancel their subscriptions; staff see them all', async () => {
  const c = ids.client;
  let page = await c.get('/account/subscriptions');
  assert.match(page.text, /2 × Daily Tea/);
  assert.match(page.text, /\$41\.00 every month/);
  await c.post(`/account/subscriptions/${ids.sub}/cancel`, {}, '/account/subscriptions');
  assert.equal((await get('SELECT cancel_at_period_end FROM subscriptions WHERE id = ?', ids.sub)).cancel_at_period_end, 1);
  page = await c.get('/account/subscriptions');
  assert.match(page.text, /Keep my subscription/);
  await c.post(`/account/subscriptions/${ids.sub}/cancel`, { resume: '1' }, '/account/subscriptions');
  assert.equal((await get('SELECT cancel_at_period_end FROM subscriptions WHERE id = ?', ids.sub)).cancel_at_period_end, 0);
  const portal = await c.post(`/account/subscriptions/${ids.sub}/billing`, {}, '/account/subscriptions');
  assert.equal(portal.location, 'https://billing.stripe.test/p/1');
  // Someone else can't touch it.
  const other = new Client(ctx.base);
  await other.post('/account/register', { first_name: 'Other', last_name: 'One', email: 'other@example.com', password: 'password123' }, '/account/register');
  assert.equal((await other.post(`/account/subscriptions/${ids.sub}/cancel`, {}, '/account')).status, 404);
  // Staff list, and Stripe telling us it ended.
  page = await owner.get('/admin/subscriptions');
  assert.match(page.text, /Daily Tea/);
  assert.match(page.text, /\$41\.00/);
  stripeSubs.get('sub_123').status = 'canceled';
  await signed({ type: 'customer.subscription.deleted', data: { object: stripeSubs.get('sub_123') } });
  assert.equal((await get('SELECT status FROM subscriptions WHERE id = ?', ids.sub)).status, 'canceled');
});

/* ---------- Abandoned carts ---------- */

async function startCheckout(email, consent) {
  const c = new Client(ctx.base);
  const v = await get("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'lemon-balm-tincture'");
  await c.post('/cart/add', { variant_id: String(v.id), quantity: '2' }, '/products/lemon-balm-tincture');
  await c.post('/checkout/information', { email, first_name: 'Ivy', last_name: 'Moss', address1: '1 Elm', city: 'Bend', province: 'OR', zip: '97701', country: 'US', ...(consent ? { accepts_marketing: '1' } : {}) }, '/checkout/information');
  return c;
}
const age = (email, hours) => run(`UPDATE abandoned_checkouts SET updated_at = now() - interval '${hours} hours', created_at = now() - interval '${hours} hours' WHERE email = ?`, email);

test('one reminder goes to shoppers who agreed to marketing and left; the link brings the cart back', async () => {
  await settings.save('abandoned_cart', { enabled: true, delay_hours: 4, require_consent: true });
  await startCheckout('ivy@example.com', true);
  await startCheckout('noconsent@example.com', false);
  const done = await startCheckout('finisher@example.com', true);
  const rate = await get("SELECT id FROM shipping_rates WHERE name = 'Standard'");
  await done.post('/checkout/shipping', { shipping_rate_id: String(rate.id) }, '/checkout/shipping');
  await done.post('/checkout/payment', { payment_method: 'bank', billing_same: 'yes' }, '/checkout/payment');
  assert.ok((await get("SELECT completed_at FROM abandoned_checkouts WHERE email = 'finisher@example.com'")).completed_at);

  assert.equal(await abandoned.remind(), 0, 'too soon');
  for (const e of ['ivy@example.com', 'noconsent@example.com', 'finisher@example.com']) await age(e, 5);
  assert.equal(await abandoned.remind(), 1);
  assert.equal(await abandoned.remind(), 0, 'only once');
  const mail = await get("SELECT * FROM email_outbox WHERE template = 'abandoned_cart'");
  assert.equal(mail.to_address, 'ivy@example.com');
  assert.match(mail.html, /2 × Lemon Balm Tincture/);
  const link = mail.html.match(/\/cart\/recover\/([\w-]+)"/)[1];
  // The link restores the cart in a new browser.
  const fresh = new Client(ctx.base);
  await fresh.get(`/cart/recover/${link}`);
  assert.match((await fresh.get('/cart')).text, /Lemon Balm Tincture/);
  assert.ok((await get('SELECT recovered_at FROM abandoned_checkouts WHERE token = ?', link)).recovered_at);
  // The stop link means no more reminders for that email.
  await fresh.get(`/cart/recover/${link}/stop`);
  assert.ok(await get("SELECT 1 FROM marketing_suppressions WHERE email = 'ivy@example.com'"));
  await startCheckout('ivy@example.com', true);
  await age('ivy@example.com', 5);
  await run("UPDATE abandoned_checkouts SET reminded_at = NULL WHERE email = 'ivy@example.com' AND token != ?", link);
  assert.equal(await abandoned.remind(), 0);
  // Staff overview.
  const page = await owner.get('/admin/orders/abandoned');
  assert.match(page.text, /ivy@example.com/);
  assert.match(page.text, /no marketing consent/);
});

test('reminders run as part of the hourly automations and stay off unless turned on', async () => {
  await settings.save('abandoned_cart', { enabled: false });
  await startCheckout('later@example.com', true);
  await age('later@example.com', 5);
  const summary = await require('../src/automation').runAll('test');
  assert.equal(summary.carts, 0);
  await settings.save('abandoned_cart', { enabled: true });
  assert.equal((await require('../src/automation').runAll('test')).carts, 1);
});
