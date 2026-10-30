'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all } = require('../src/db');

let ctx;
before(async () => { ctx = await start(); });
after(() => ctx.close());

test('storefront pages render', async () => {
  const c = new Client(ctx.base);
  for (const url of ['/', '/collections', '/collections/all', '/collections/best-sellers', '/products/chamomile-meadow-tea',
    '/search?q=tea', '/cart', '/pages/about', '/pages/contact', '/blogs/news', '/policies/refund', '/sitemap.xml', '/account/login']) {
    const res = await c.get(url);
    assert.equal(res.status, 200, url);
  }
  assert.equal((await c.get('/products/does-not-exist')).status, 404);
});

test('POST without CSRF token is rejected', async () => {
  const c = new Client(ctx.base);
  const res = await c.request('POST', '/cart/add', { variant_id: '1', quantity: '1' });
  assert.equal(res.status, 403);
});

test('guest checkout with discount places an order and decrements inventory', async () => {
  const c = new Client(ctx.base);
  const variant = await get("SELECT v.* FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'lemon-balm-tincture'");
  await c.post('/cart/add', { variant_id: String(variant.id), quantity: '3' }, '/products/lemon-balm-tincture');
  const cart = await c.get('/cart');
  assert.match(cart.text, /Lemon Balm Tincture/);

  let res = await c.post('/checkout/information', {
    email: 'buyer@example.com', first_name: 'Rae', last_name: 'Lee', address1: '1 Elm St', city: 'Oakland', province: 'CA', zip: '94601', country: 'US',
  }, '/checkout/information');
  assert.equal(res.location, '/checkout/shipping');

  await c.post('/checkout/discount', { code: 'WELCOME10', step: 'shipping' }, '/checkout/shipping');
  const shippingPage = await c.get('/checkout/shipping');
  assert.match(shippingPage.text, /WELCOME10/);
  // 3 x $22 = $66 subtotal, minus 10% = $59.40 -> under the $100 free shipping threshold
  const options = await c.get('/checkout/shipping');
  assert.doesNotMatch(options.text, /Free standard shipping/);
  const rate = await get("SELECT id FROM shipping_rates WHERE name = 'Standard'");
  res = await c.post('/checkout/shipping', { shipping_rate_id: String(rate.id) }, '/checkout/shipping');
  assert.equal(res.location, '/checkout/payment');

  res = await c.post('/checkout/payment', { payment_method: 'bank', billing_same: 'yes' }, '/checkout/payment');
  assert.match(res.location, /^\/checkout\/thank-you\//);
  const thanks = await c.get(res.location);
  assert.equal(thanks.status, 200);
  assert.match(thanks.text, /Your order is confirmed/);

  const order = await get("SELECT * FROM orders WHERE email = 'buyer@example.com'");
  assert.equal(order.subtotal, 6600);
  assert.equal(order.discount_total, 660);
  assert.equal(order.shipping_total, 600);
  assert.equal(order.tax_total, Math.round(5940 * 0.0725)); // CA rate
  assert.equal(order.total, 5940 + 600 + order.tax_total);
  assert.equal(order.financial_status, 'pending');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', variant.id)).inventory_qty, variant.inventory_qty - 3);
  assert.equal((await get("SELECT used_count FROM discounts WHERE code = 'WELCOME10'")).used_count, 1);
  assert.ok(await get("SELECT 1 FROM email_outbox WHERE to_address = 'buyer@example.com'"), 'confirmation email recorded');
});

test('sold-out products cannot be added to the cart', async () => {
  const c = new Client(ctx.base);
  const v = await get("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'wild-rose-facial-oil'");
  await c.post('/cart/add', { variant_id: String(v.id), quantity: '1' }, '/products/wild-rose-facial-oil');
  const cart = await c.get('/cart');
  assert.match(cart.text, /Your cart is empty/);
});

test('customer can register, log in and see order history', async () => {
  const c = new Client(ctx.base);
  let res = await c.post('/account/register', { email: 'buyer@example.com', password: 'longenough1', first_name: 'Rae' }, '/account/register');
  assert.equal(res.location, '/account');
  const account = await c.get('/account');
  assert.match(account.text, /#\d{4}/, 'previous guest order is linked to the claimed account');
  await c.post('/account/logout', {}, '/account');
  res = await c.post('/account/login', { email: 'buyer@example.com', password: 'wrong' }, '/account/login');
  assert.match(res.location, /\/account\/login/);
  res = await c.post('/account/login', { email: 'buyer@example.com', password: 'longenough1', next: '/account' }, '/account/login');
  assert.equal(res.location, '/account');
});

test('discount codes enforce minimum subtotal', async () => {
  const { validateDiscount } = require('../src/pricing');
  const small = { subtotal: 1000, lines: [] };
  assert.match((await validateDiscount('SPRING5', small)).error, /Spend/);
  assert.ok((await validateDiscount('SPRING5', { subtotal: 4000, lines: [] })).discount);
  assert.match((await validateDiscount('NOPE', small)).error, /not valid/);
});

test('smart collections match their rules', async () => {
  const catalog = require('../src/catalog');
  const teas = await catalog.collectionProducts(await catalog.collectionByHandle('herbal-teas'));
  assert.ok(teas.length >= 4);
  assert.ok(teas.every((p) => p.product_type === 'Tea'));
  const tinctures = await catalog.collectionProducts(await catalog.collectionByHandle('tinctures'));
  assert.deepEqual([...new Set(tinctures.map((p) => p.product_type))].sort(), ['Syrup', 'Tincture']);
  assert.ok((await all('SELECT * FROM collections')).length >= 5);
});

test('theme text colors stay readable on light brand colors', () => {
  const { themeColors, contrast } = require('../src/colors');
  const theme = { color_primary: '#77b48a', color_accent: '#809ec4', color_background: '#ffffff' };
  const c = themeColors(theme);
  assert.ok(contrast(c.onPrimary, theme.color_primary) >= 4.5);
  assert.ok(contrast(c.onAccent, theme.color_accent) >= 4.5);
  assert.ok(contrast(c.primaryInk, theme.color_background) >= 4.5);
  assert.ok(contrast(c.accentInk, theme.color_background) >= 4.5);
});
