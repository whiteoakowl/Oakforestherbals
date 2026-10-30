'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all } = require('../src/db');

let ctx;
let admin;
before(async () => {
  ctx = await start();
  admin = new Client(ctx.base);
  const res = await admin.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(res.location, '/admin');
});
after(() => ctx.close());

test('admin requires login', async () => {
  const c = new Client(ctx.base);
  const res = await c.get('/admin/orders');
  assert.equal(res.status, 302);
  assert.match(res.location, /\/admin\/login/);
});

test('every admin screen renders', async () => {
  const product = (await get('SELECT id FROM products LIMIT 1')).id;
  const order = (await get('SELECT id FROM orders LIMIT 1')).id;
  const customer = (await get('SELECT id FROM customers LIMIT 1')).id;
  const collection = (await get('SELECT id FROM collections LIMIT 1')).id;
  const discount = (await get('SELECT id FROM discounts LIMIT 1')).id;
  const page = (await get('SELECT id FROM pages LIMIT 1')).id;
  const article = (await get('SELECT id FROM articles LIMIT 1')).id;
  const menu = (await get('SELECT id FROM menus LIMIT 1')).id;
  const urls = ['/admin', '/admin?range=7', '/admin?range=365', '/admin/analytics', '/admin/orders', '/admin/orders?tab=unfulfilled', '/admin/orders/new',
    `/admin/orders/${order}`, `/admin/orders/${order}/packing-slip`, '/admin/orders/export.csv',
    '/admin/products', '/admin/products/new', `/admin/products/${product}`, '/admin/products/inventory', '/admin/products/export.csv',
    '/admin/collections', '/admin/collections/new', `/admin/collections/${collection}`,
    '/admin/customers', '/admin/customers/new', `/admin/customers/${customer}`, '/admin/customers/export.csv',
    '/admin/discounts', '/admin/discounts/new', `/admin/discounts/${discount}`,
    '/admin/content/pages', '/admin/content/pages/new', `/admin/content/pages/${page}`,
    '/admin/content/blog', '/admin/content/blog/new', `/admin/content/blog/${article}`,
    '/admin/content/navigation', `/admin/content/navigation/${menu}`, '/admin/content/files',
    '/admin/themes', '/admin/themes/customize', '/admin/profile',
    '/admin/settings', '/admin/settings/general', '/admin/settings/payments', '/admin/settings/checkout', '/admin/settings/shipping',
    '/admin/settings/taxes', '/admin/settings/notifications', '/admin/settings/policies', '/admin/settings/preferences', '/admin/settings/staff'];
  for (const url of urls) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, `${url} -> ${res.status} ${res.text.slice(0, 200)}`);
  }
});

test('create a product with variants, then edit a variant price', async () => {
  let res = await admin.post('/admin/products/new', {
    title: 'Test Tea', status: 'active', price: '10.00', track_inventory: '1', requires_shipping: '1', taxable: '1',
    'options[0][name]': 'Size', 'options[0][values]': 'Small, Large',
    'options[1][name]': 'Blend', 'options[1][values]': 'Mint, Rose',
  }, '/admin/products/new');
  assert.match(res.location, /\/admin\/products\/\d+/);
  const id = Number(res.location.split('/').pop());
  const variants = await all('SELECT * FROM variants WHERE product_id = ? ORDER BY position', id);
  assert.deepEqual(variants.map((v) => v.title), ['Small / Mint', 'Small / Rose', 'Large / Mint', 'Large / Rose']);
  assert.ok(variants.every((v) => v.price === 1000));

  const large = variants[2];
  const body = {
    title: 'Test Tea', status: 'active', price: '10.00', track_inventory: '1', requires_shipping: '1', taxable: '1',
    'options[0][name]': 'Size', 'options[0][values]': 'Small, Large',
    'options[1][name]': 'Blend', 'options[1][values]': 'Mint, Rose',
  };
  for (const v of variants) {
    body[`variants[id${v.id}][price]`] = v.id === large.id ? '14.50' : '10.00';
    body[`variants[id${v.id}][inventory_qty]`] = '5';
  }
  await admin.post(`/admin/products/${id}`, body, `/admin/products/${id}`);
  assert.equal((await get('SELECT price FROM variants WHERE id = ?', large.id)).price, 1450);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', large.id)).inventory_qty, 5);
  const page = await new Client(ctx.base).get('/products/test-tea');
  assert.equal(page.status, 200);
});

test('fulfill, refund and cancel an order', async () => {
  const order = await get("SELECT * FROM orders WHERE fulfillment_status = 'unfulfilled' AND status = 'open' LIMIT 1");
  const items = await all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const body = { tracking_company: 'USPS', tracking_number: '9400', notify: '1' };
  for (const i of items) body[`qty[id${i.id}]`] = String(i.quantity);
  await admin.post(`/admin/orders/${order.id}/fulfill`, body, `/admin/orders/${order.id}`);
  assert.equal((await get('SELECT fulfillment_status FROM orders WHERE id = ?', order.id)).fulfillment_status, 'fulfilled');

  await admin.post(`/admin/orders/${order.id}/paid`, {}, `/admin/orders/${order.id}`);
  assert.equal((await get('SELECT financial_status FROM orders WHERE id = ?', order.id)).financial_status, 'paid');

  await admin.post(`/admin/orders/${order.id}/refund`, { amount: '1.00' }, `/admin/orders/${order.id}`);
  const refunded = await get('SELECT * FROM orders WHERE id = ?', order.id);
  assert.equal(refunded.refunded_total, 100);
  assert.equal(refunded.financial_status, 'partially_refunded');

  const v = items[0];
  const before = (await get('SELECT inventory_qty FROM variants WHERE id = ?', v.variant_id)).inventory_qty;
  await admin.post(`/admin/orders/${order.id}/cancel`, { restock: '1', reason: 'Other' }, `/admin/orders/${order.id}`);
  assert.equal((await get('SELECT status FROM orders WHERE id = ?', order.id)).status, 'cancelled');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', v.variant_id)).inventory_qty, before + v.quantity);
});

test('settings and theme save', async () => {
  await admin.post('/admin/settings/general', { name: 'Renamed Store', currency: 'USD', currency_symbol: '$', order_prefix: 'OF-' }, '/admin/settings/general');
  await admin.post('/admin/themes/customize', { color_primary: '#123456', font_heading: 'Lora', font_body: 'Inter', hero_enabled: '1', hero_heading: 'Hello forest' }, '/admin/themes');
  const home = await new Client(ctx.base).get('/');
  assert.match(home.text, /Renamed Store/);
  assert.match(home.text, /#123456/);
  assert.match(home.text, /Hello forest/);
});

test('discount and page CRUD', async () => {
  let res = await admin.post('/admin/discounts/new', { code: 'test20', kind: 'percentage', value: '20', active: '1' }, '/admin/discounts/new');
  assert.match(res.location, /\/admin\/discounts\/\d+/);
  assert.equal((await get("SELECT value FROM discounts WHERE code = 'TEST20'")).value, 20);
  res = await admin.post('/admin/content/pages/new', { title: 'Wholesale', body_html: '<p>Hi</p>', published: '1' }, '/admin/content/pages/new');
  assert.equal((await new Client(ctx.base).get('/pages/wholesale')).status, 200);
});

test('store password page blocks visitors but not staff', async () => {
  await admin.post('/admin/settings/preferences', { password_enabled: '1', password: 'opensesame', password_message: 'Soon' }, '/admin/settings/preferences');
  const visitor = new Client(ctx.base);
  const res = await visitor.get('/');
  assert.equal(res.location, '/password');
  assert.equal((await admin.get('/')).status, 200);
  const unlock = await visitor.post('/password', { password: 'opensesame' }, '/password');
  assert.equal(unlock.location, '/');
  await admin.post('/admin/settings/preferences', { password: '' }, '/admin/settings/preferences');
});
