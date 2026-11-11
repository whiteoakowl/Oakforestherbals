'use strict';
// Phase 3: costing, profitability, wholesale pricing, product details, scheduled publishing,
// point of sale and the shared login throttle.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');
const costing = require('../src/costing');

let ctx;
let owner;

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  const res = await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(res.location, '/admin');
});
after(() => ctx.close());

const idFrom = (location) => Number(location.split('/').pop().split('#')[0]);

async function addMaterial(fields) {
  const res = await owner.post('/admin/costing/materials/new', fields, '/admin/costing');
  assert.match(res.location || '', /\/admin\/costing\/materials\/\d+$/, 'material should be created');
  return idFrom(res.location);
}

test('unit conversion and cost maths', () => {
  assert.equal(costing.convert(1, 'lb', 'g'), 453.59237);
  assert.ok(Math.abs(costing.convert(1, 'oz', 'g') - 28.349523125) < 1e-9);
  assert.equal(costing.convert(2, 'l', 'ml'), 2000);
  assert.equal(costing.convert(1, 'g', 'ml'), null, 'mass and volume do not convert');
  const herb = { name: 'Chamomile', pack_size: 1, pack_unit: 'lb', pack_cost: 2400 };
  const bottle = { name: 'Bottle', pack_size: 100, pack_unit: 'each', pack_cost: 4500 };
  const r = costing.calculate(
    [{ quantity: 30, unit: 'g', material: herb }, { quantity: 1, unit: 'each', material: bottle }],
    { labour_minutes: 6, waste_percent: 10, overhead_percent: 20, extra_cost: 10 },
    { labour_rate: 2000 },
  );
  // 30 g of $24/lb = 158.73c; bottle 45c -> materials 203.73c; waste 20.37c; labour 200c; extra 10c.
  // Before overhead 434.10c; overhead 20% = 86.82c; total 520.92c -> 521c.
  assert.equal(r.materials, 204);
  assert.equal(r.waste, 20);
  assert.equal(r.labour, 200);
  assert.equal(r.overhead, 87);
  assert.equal(r.total, 521);
  assert.deepEqual(r.problems, []);
  const bad = costing.calculate([{ quantity: 5, unit: 'ml', material: herb }], {}, { labour_rate: 0 });
  assert.equal(bad.problems.length, 1);
  assert.deepEqual(costing.margin(1000, 400), { profit: 600, percent: 60 });
  assert.equal(costing.margin(0, 400), null);
});

test('build a recipe, roll the cost up, and see the impact of a supplier price rise', async () => {
  await owner.post('/admin/costing/settings', { labour_rate: '20.00', default_waste_percent: '10', default_overhead_percent: '0' }, '/admin/costing');
  const herb = await addMaterial({ name: 'Chamomile flower', botanical_name: 'Matricaria chamomilla', kind: 'herb', pack_size: '1', pack_unit: 'lb', pack_cost: '24.00', supplier: 'Mountain Co' });
  const tin = await addMaterial({ name: 'Tea tin', kind: 'container', pack_size: '50', pack_unit: 'each', pack_cost: '50.00' });
  const product = await get("SELECT p.id, v.id AS vid, v.price FROM products p JOIN variants v ON v.product_id = p.id WHERE p.status = 'active' ORDER BY p.id LIMIT 1");
  assert.equal((await owner.get(`/admin/costing/products/${product.id}`)).status, 200);
  let res = await owner.post(`/admin/costing/products/${product.id}/variants/${product.vid}`, {
    'lines[0][material_id]': herb, 'lines[0][quantity]': '2', 'lines[0][unit]': 'oz',
    'lines[1][material_id]': tin, 'lines[1][quantity]': '1', 'lines[1][unit]': 'each',
    labour_minutes: '3', wholesale_price: '6.00', use_calculated: '1',
  }, `/admin/costing/products/${product.id}`);
  assert.equal(res.status, 302);
  // 2 oz = 56.699 g of $24/lb = 300c; tin 100c; materials 400c; waste 10% = 40c; labour 3 min at $20/h = 100c -> 540c.
  let v = await get('SELECT cost, wholesale_price FROM variants WHERE id = ?', product.vid);
  assert.equal(v.cost, 540);
  assert.equal(v.wholesale_price, 600);

  // Supplier raises chamomile to $36/lb: herb cost 450c, materials 550c, waste 55c, labour 100c -> 705c.
  res = await owner.post(`/admin/costing/materials/${herb}`, { name: 'Chamomile flower', kind: 'herb', pack_size: '1', pack_unit: 'lb', pack_cost: '36.00' }, `/admin/costing/materials/${herb}`);
  assert.equal(res.status, 302);
  v = await get('SELECT cost FROM variants WHERE id = ?', product.vid);
  assert.equal(v.cost, 705);
  const page = await owner.get(`/admin/costing/materials/${herb}`);
  assert.match(page.text, /Cost change impact/);
  assert.match(page.text, /\$5\.40/);
  assert.match(page.text, /\$7\.05/);
  assert.equal((await all('SELECT * FROM material_price_history WHERE material_id = ?', herb)).length, 2);
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'material.price_changed' AND entity_id = ?", String(herb)));

  // A manually-costed variant keeps its cost when inputs change.
  await owner.post(`/admin/costing/products/${product.id}/variants/${product.vid}`, {
    'lines[0][material_id]': herb, 'lines[0][quantity]': '2', 'lines[0][unit]': 'oz', labour_minutes: '0',
  }, `/admin/costing/products/${product.id}`);
  assert.equal((await get('SELECT cost FROM variants WHERE id = ?', product.vid)).cost, 705);
  const calc = await get('SELECT calculated_cost FROM variant_costing WHERE variant_id = ?', product.vid);
  assert.equal(calc.calculated_cost, 495, '2 oz at $36/lb = 450c plus 10% waste');

  // Guard rails.
  res = await owner.post(`/admin/costing/products/${product.id}/variants/${product.vid}`, {
    'lines[0][material_id]': herb, 'lines[0][quantity]': '5', 'lines[0][unit]': 'ml', use_calculated: '1',
  }, `/admin/costing/products/${product.id}`);
  assert.equal((await all('SELECT * FROM variant_materials WHERE variant_id = ?', product.vid)).length, 1, 'a bad line leaves the recipe unchanged');
  await owner.post(`/admin/costing/materials/${herb}/delete`, {}, `/admin/costing/materials/${herb}`);
  assert.ok(await get('SELECT 1 FROM materials WHERE id = ?', herb), 'materials in use cannot be deleted');
  await owner.post(`/admin/costing/materials/${herb}`, { name: 'Chamomile flower', kind: 'herb', pack_size: '1', pack_unit: 'each', pack_cost: '36.00' }, `/admin/costing/materials/${herb}`);
  assert.equal((await get('SELECT pack_unit FROM materials WHERE id = ?', herb)).pack_unit, 'lb', 'a used material cannot switch from weight to count');
  assert.equal((await owner.get('/admin/costing')).status, 200);
});

test('orders record the unit cost at sale time and profitability reports it', async () => {
  const v = await get("SELECT v.id, v.cost, v.price FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' AND v.cost IS NOT NULL AND (v.track_inventory = 0 OR v.inventory_qty > 2) ORDER BY v.id LIMIT 1");
  const pricing = require('../src/pricing');
  const orders = require('../src/orders');
  const cart = await pricing.buildCart([{ variant_id: v.id, quantity: 2 }]);
  const totals = await pricing.computeTotals(cart, {});
  const order = await orders.createOrder({ cart, totals, contact: { email: 'cost@example.com' }, shippingAddress: {}, payment: { name: 'Test' } });
  const item = await get('SELECT unit_cost FROM order_items WHERE order_id = ?', order.id);
  assert.equal(item.unit_cost, v.cost);
  await run('UPDATE variants SET cost = cost + 1000 WHERE id = ?', v.id);
  assert.equal((await get('SELECT unit_cost FROM order_items WHERE order_id = ?', order.id)).unit_cost, v.cost, 'history does not change when cost does');
  for (const range of ['30', '90', '365', 'all']) {
    const res = await owner.get(`/admin/analytics/profitability?range=${range}&sort=margin`);
    assert.equal(res.status, 200, range);
  }
  const csv = await owner.get('/admin/analytics/profitability/export.csv?range=all');
  assert.match(csv.text, /^Product,Variant,Category/);
});

test('wholesale customers pay wholesale prices; retail customers do not', async () => {
  const pricing = require('../src/pricing');
  const v = await get("SELECT v.id, v.price FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' AND (v.track_inventory = 0 OR v.inventory_qty > 5) ORDER BY v.id DESC LIMIT 1");
  await run('UPDATE variants SET wholesale_price = ? WHERE id = ?', Math.round(v.price / 2), v.id);
  const retail = await pricing.buildCart([{ variant_id: v.id, quantity: 1 }]);
  const wholesale = await pricing.buildCart([{ variant_id: v.id, quantity: 1 }], { priceList: 'wholesale' });
  assert.equal(retail.lines[0].price, v.price);
  assert.equal(wholesale.lines[0].price, Math.round(v.price / 2));
  assert.equal(wholesale.lines[0].wholesale, true);

  // End to end: an admin moves a customer to the wholesale group, and their cart reprices.
  const shopper = new Client(ctx.base);
  await shopper.post('/account/register', { first_name: 'Willa', last_name: 'Shop', email: 'willa@example.com', password: 'password123' }, '/account/register');
  const cust = await get("SELECT id FROM customers WHERE email = 'willa@example.com'");
  await owner.post(`/admin/customers/${cust.id}`, { first_name: 'Willa', last_name: 'Shop', customer_group: 'wholesale' }, `/admin/customers/${cust.id}`);
  assert.equal((await get('SELECT customer_group FROM customers WHERE id = ?', cust.id)).customer_group, 'wholesale');
  await shopper.post('/cart/add', { variant_id: v.id, quantity: 1 }, '/');
  const cartJson = JSON.parse((await shopper.get('/cart.json')).text);
  assert.equal(cartJson.subtotal, Math.round(v.price / 2));
  assert.equal((await owner.get('/admin/customers?segment=wholesale')).status, 200);
});

test('product details show on the product page and scheduled drafts go live', async () => {
  const p = await get("SELECT id, handle, title FROM products WHERE status = 'active' ORDER BY id LIMIT 1");
  const full = await require('../src/catalog').productById(p.id);
  const body = { title: full.title, handle: full.handle, status: 'active', price: (full.variants[0].price / 100).toFixed(2),
    track_inventory: '1', requires_shipping: '1', taxable: '1', inventory_qty: String(full.variants[0].inventory_qty),
    ingredients: 'Organic chamomile flower', directions: 'Steep 1 tsp in hot water.', warnings: 'Avoid if allergic to the daisy family.' };
  if (full.options.length) {
    // Keep the variant set unchanged for multi-variant products.
    full.options.forEach((name, i) => { body[`options[${i}][name]`] = name; body[`options[${i}][values]`] = [...new Set(full.variants.map((v) => v[`option${i + 1}`]))].join(', '); });
  }
  await owner.post(`/admin/products/${p.id}`, body, `/admin/products/${p.id}`);
  const page = await new Client(ctx.base).get(`/products/${full.handle}`);
  assert.match(page.text, /Organic chamomile flower/);
  assert.match(page.text, /Avoid if allergic to the daisy family/);

  const res = await owner.post('/admin/products/new', { title: 'Spring Tonic', status: 'draft', price: '12.00', publish_at: '2020-01-01T09:00' }, '/admin/products/new');
  const id = idFrom(res.location);
  assert.equal((await get('SELECT status FROM products WHERE id = ?', id)).status, 'draft');
  assert.equal(await require('../src/catalog').publishScheduled(), 1);
  const row = await get('SELECT status, publish_at FROM products WHERE id = ?', id);
  assert.equal(row.status, 'active');
  assert.equal(row.publish_at, null);
  const later = await owner.post('/admin/products/new', { title: 'Autumn Blend', status: 'draft', price: '12.00', publish_at: '2999-01-01T09:00' }, '/admin/products/new');
  await require('../src/catalog').publishScheduled();
  assert.equal((await get('SELECT status FROM products WHERE id = ?', idFrom(later.location))).status, 'draft');
});

test('point of sale: cash sale with change, stock deducted, paid and fulfilled', async () => {
  const v = await get(`SELECT v.id, v.price, v.inventory_qty, v.barcode FROM variants v JOIN products p ON p.id = v.product_id
    WHERE p.status = 'active' AND v.track_inventory = 1 AND v.inventory_qty > 3 ORDER BY v.id LIMIT 1`);
  await run("UPDATE variants SET barcode = '0123456789012' WHERE id = ?", v.id);
  assert.equal((await owner.get('/admin/pos?q=tea')).status, 200);
  // Scanning the barcode adds the item.
  const scan = await owner.get('/admin/pos?q=0123456789012');
  assert.equal(scan.location, '/admin/pos');
  await owner.post('/admin/pos/add', { variant_id: v.id, quantity: 1 }, '/admin/pos');
  let page = await owner.get('/admin/pos');
  assert.match(page.text, /Complete sale/);
  // Not enough cash.
  let res = await owner.post('/admin/pos/complete', { method: 'cash', tendered: '0.01' }, '/admin/pos');
  assert.equal(res.location, '/admin/pos');
  assert.equal((await get("SELECT COUNT(*) AS n FROM orders WHERE source = 'pos'")).n, 0);
  res = await owner.post('/admin/pos/complete', { method: 'cash', tendered: '1000.00' }, '/admin/pos');
  assert.match(res.location, /\/admin\/pos\/receipt\/\d+/);
  const order = await get("SELECT * FROM orders WHERE source = 'pos' ORDER BY id DESC LIMIT 1");
  assert.equal(order.financial_status, 'paid');
  assert.equal(order.fulfillment_status, 'fulfilled');
  assert.equal(order.customer_id, null, 'walk-in sale without a customer');
  assert.equal(order.subtotal, v.price * 2);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', v.id)).inventory_qty, v.inventory_qty - 2);
  const receipt = await owner.get(res.location);
  assert.match(receipt.text, /Change/);
  assert.match(receipt.text, new RegExp(`\\$${((100000 - order.total) / 100).toFixed(2).replace('.', '\\.')}`));
  page = await owner.get('/admin/pos');
  assert.match(page.text, /No items yet/, 'the sale is cleared after completion');
});

test('costing and POS are permission-gated', async () => {
  await owner.post('/admin/settings/staff', { name: 'Herbalist', email: 'herb2@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email: 'herb2@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  for (const url of ['/admin/costing', '/admin/costing/materials/new', '/admin/analytics/profitability', '/admin/pos']) {
    assert.equal((await c.get(url)).status, 403, url);
  }
  assert.equal((await c.post('/admin/pos/complete', { method: 'cash', tendered: '10' }, '/admin')).status, 403);
});

test('login throttle is shared through the database', async () => {
  const c = new Client(ctx.base);
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/account/login', { email: 'nobody@example.com', password: 'wrong' }, '/account/login');
  assert.equal(last.status, 429);
  assert.ok((await get("SELECT count FROM login_attempts WHERE key LIKE 'customer:%'")).count >= 11);
});
