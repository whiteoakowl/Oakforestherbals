'use strict';
// Phase 5 end to end: purchase -> lots -> formula -> component -> product recipe -> batches ->
// release -> sale (oldest lot first) -> traceability -> restock -> recall -> price cascade.
// Materials are fictional test items.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');

let ctx;
let owner;
const ids = {};
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

async function material(fields) {
  const res = await owner.post('/admin/costing/materials/new', fields, '/admin/costing/materials/new');
  assert.match(res.location || '', /materials\/\d+$/, `material ${fields.name}`);
  return Number(res.location.split('/').pop());
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  // No labour/overhead/waste so the maths below is about materials only.
  await owner.post('/admin/costing/settings', { labour_rate: '0', default_waste_percent: '0', default_overhead_percent: '0' }, '/admin/costing');
});
after(() => ctx.close());

test('purchase order: landed cost per lot, price update, stock and movements', async () => {
  await owner.post('/admin/inventory/suppliers/new', { name: 'Test Botanicals Co', lead_time_days: '7' }, '/admin/inventory/suppliers/new');
  ids.supplier = (await get("SELECT id FROM suppliers WHERE name = 'Test Botanicals Co'")).id;
  ids.herb = await material({ name: 'Testwort leaf', kind: 'herb', pack_size: '1', pack_unit: 'kg', pack_cost: '20.00', reorder_point: '500', stock_unit: 'g', supplier_id: ids.supplier });
  ids.alcohol = await material({ name: 'Test grain alcohol', kind: 'ingredient', pack_size: '1', pack_unit: 'l', pack_cost: '30.00' });
  ids.bottle = await material({ name: 'Test 30 ml bottle', kind: 'container', pack_size: '100', pack_unit: 'each', pack_cost: '50.00' });
  ids.label = await material({ name: 'Test label', kind: 'label', pack_size: '500', pack_unit: 'each', pack_cost: '25.00' });
  ids.flower = await material({ name: 'Testflower', kind: 'herb', pack_size: '1', pack_unit: 'kg', pack_cost: '30.00' });

  let res = await owner.post('/admin/inventory/purchase-orders/new', { supplier_id: ids.supplier }, '/admin/inventory/purchase-orders/new');
  const po = Number(res.location.split('/').pop());
  const from = `/admin/inventory/purchase-orders/${po}`;
  await owner.post(from, { supplier_id: ids.supplier, add_material_id: ids.herb }, from);
  const herbItem = await get('SELECT id FROM purchase_order_items WHERE purchase_order_id = ?', po);
  // 2 packs of 1 kg at $22 (the supplier raised the price), plus alcohol; $10 shipping.
  await owner.post(from, { supplier_id: ids.supplier, shipping_cost: '10.00', 'items[0][id]': herbItem.id, 'items[0][packs]': '2', 'items[0][pack_size]': '1', 'items[0][pack_unit]': 'kg', 'items[0][pack_cost]': '22.00', add_material_id: ids.alcohol }, from);
  const alcItem = await get('SELECT id FROM purchase_order_items WHERE purchase_order_id = ? AND material_id = ?', po, ids.alcohol);
  await owner.post(from, { supplier_id: ids.supplier, shipping_cost: '10.00', 'items[0][id]': herbItem.id, 'items[0][packs]': '2', 'items[0][pack_size]': '1', 'items[0][pack_unit]': 'kg', 'items[0][pack_cost]': '22.00',
    'items[1][id]': alcItem.id, 'items[1][packs]': '4', 'items[1][pack_size]': '1', 'items[1][pack_unit]': 'l', 'items[1][pack_cost]': '30.00' }, from);
  await owner.post(`${from}/status`, { status: 'ordered' }, from);
  assert.equal((await get('SELECT status FROM purchase_orders WHERE id = ?', po)).status, 'ordered');
  // Receive only 1 of the 2 herb packs first: partial.
  await owner.post(`${from}/receive`, { 'receive[0][item_id]': herbItem.id, 'receive[0][packs]': '1', 'receive[0][expires_at]': '2030-01-01', 'receive[0][supplier_lot]': 'SUP-A1',
    'receive[1][item_id]': alcItem.id, 'receive[1][packs]': '4' }, from);
  assert.equal((await get('SELECT status FROM purchase_orders WHERE id = ?', po)).status, 'partial');
  await owner.post(`${from}/receive`, { 'receive[0][item_id]': herbItem.id, 'receive[0][packs]': '1', 'receive[0][expires_at]': '2031-01-01', 'receive[0][supplier_lot]': 'SUP-A2' }, from);
  assert.equal((await get('SELECT status FROM purchase_orders WHERE id = ?', po)).status, 'received');
  // Goods $44 + $120 = $164; shipping $10 split by value: herb share 44/164*10 = $2.68 over 2 kg.
  const herbLots = await all('SELECT * FROM material_lots WHERE material_id = ? ORDER BY id', ids.herb);
  assert.equal(herbLots.length, 2);
  near(Number(herbLots[0].unit_cost) * 1000, 2200 + (4400 / 16400) * 1000 / 2 * 1, 0.6); // cents per kg
  assert.equal(Number(herbLots[0].qty_remaining), 1000);
  const herb = await get('SELECT pack_cost, pack_unit FROM materials WHERE id = ?', ids.herb);
  assert.equal(herb.pack_cost, 2200, 'latest purchase price becomes the replacement price');
  assert.ok(await get("SELECT 1 FROM inventory_transactions WHERE material_id = ? AND kind = 'receive' AND purchase_order_id = ?", ids.herb, po));
  // Quick receive (no PO) for bottles, labels and flowers.
  for (const [id, qty, unit, cost] of [[ids.bottle, '200', 'each', '100.00'], [ids.label, '500', 'each', '25.00'], [ids.flower, '1', 'kg', '30.00']]) {
    await owner.post(`/admin/inventory/materials/${id}/receive`, { qty, unit, total_cost: cost }, `/admin/inventory/materials/${id}`);
  }
  for (const url of ['/admin/inventory', `/admin/inventory/materials/${ids.herb}`, from, `${from}/print`, '/admin/inventory/suppliers', `/admin/inventory/suppliers/${ids.supplier}`, '/admin/inventory/locations', '/admin/inventory/purchase-orders', '/admin/inventory/export.csv']) {
    assert.equal((await owner.get(url)).status, 200, url);
  }
});

test('adjustments, waste and counts are recorded with reasons and never go below zero', async () => {
  const lot = await get('SELECT * FROM material_lots WHERE material_id = ?', ids.label);
  const from = `/admin/inventory/materials/${ids.label}`;
  await owner.post('/admin/inventory/lots/adjust', { lot: lot.id, kind: 'waste', qty: '20', reason: '' }, from);
  assert.equal(Number((await get('SELECT qty_remaining FROM material_lots WHERE id = ?', lot.id)).qty_remaining), 500, 'reason required');
  await owner.post('/admin/inventory/lots/adjust', { lot: lot.id, kind: 'waste', qty: '20', reason: 'Misprinted' }, from);
  await owner.post('/admin/inventory/lots/adjust', { lot: lot.id, kind: 'count', qty: '470', reason: 'Monthly count' }, from);
  await owner.post('/admin/inventory/lots/adjust', { lot: lot.id, kind: 'adjustment', qty: '-1000', reason: 'Typo' }, from);
  assert.equal(Number((await get('SELECT qty_remaining FROM material_lots WHERE id = ?', lot.id)).qty_remaining), 470);
  const kinds = (await all('SELECT kind, qty FROM inventory_transactions WHERE lot_id = ? ORDER BY id', lot.id)).map((t) => `${t.kind}:${Number(t.qty)}`);
  assert.deepEqual(kinds, ['receive:500', 'waste:-20', 'count:-10']);
});

test('formulas: parts are converted from the yield, costed, and need approval with a safety review', async () => {
  // Parts: 2 parts Testflower + 1 part Testwort, batch 300 g -> 200 g + 100 g.
  let res = await owner.post('/admin/formulas/new', { name: 'Test tea blend', category: 'tea', entry_mode: 'parts', yield_qty: '300', yield_unit: 'g',
    'lines[0][material_id]': ids.flower, 'lines[0][quantity]': '2', 'lines[1][material_id]': ids.herb, 'lines[1][quantity]': '1' }, '/admin/formulas/new');
  const tea = Number(res.location.split('/').pop());
  let page = await owner.get(`/admin/formulas/${tea}`);
  assert.match(page.text, /200 g/);
  assert.match(page.text, /100 g/);
  assert.match(page.text, /66\.7%/);
  // 200 g @ $30/kg = $6.00; 100 g @ $22/kg = $2.20 -> $8.20.
  assert.match(page.text, /\$8\.20/);
  page = await owner.get(`/admin/formulas/${tea}?qty=3&unit=kg`);
  assert.match(page.text, /2000 g/, 'scaled ×10');
  assert.match(page.text, /Not linked to the herbal database/);
  assert.equal((await owner.get(`/admin/formulas/${tea}/sheet?qty=3&unit=kg`)).status, 200);

  // Tincture by amounts: 200 g herb in 1 l alcohol, yields 1000 ml.
  res = await owner.post('/admin/formulas/new', { name: 'Testwort tincture (bulk)', category: 'tincture', entry_mode: 'amount', yield_qty: '1000', yield_unit: 'ml', shelf_life_days: '730',
    'lines[0][material_id]': ids.herb, 'lines[0][quantity]': '200', 'lines[0][unit]': 'g', 'lines[1][material_id]': ids.alcohol, 'lines[1][quantity]': '1', 'lines[1][unit]': 'l' }, '/admin/formulas/new');
  ids.tincture = Number(res.location.split('/').pop());
  // Not approved -> can't be produced.
  res = await owner.post('/admin/production/new', { make: `formula:${ids.tincture}`, planned_qty: '1000' }, '/admin/production/new');
  assert.equal(res.location, '/admin/production/new');
  await owner.post(`/admin/formulas/${ids.tincture}/approve`, {}, `/admin/formulas/${ids.tincture}`);
  assert.equal((await get('SELECT status FROM formulas WHERE id = ?', ids.tincture)).status, 'draft', 'safety review must be confirmed');
  await owner.post(`/admin/formulas/${ids.tincture}/approve`, { reviewed_safety: '1', note: 'First approval' }, `/admin/formulas/${ids.tincture}`);
  const f = await get('SELECT status, version FROM formulas WHERE id = ?', ids.tincture);
  assert.equal(f.status, 'approved');
  assert.ok(await get('SELECT 1 FROM formula_versions WHERE formula_id = ? AND version = 1', ids.tincture));
  await owner.post(`/admin/formulas/${ids.tincture}/component`, {}, `/admin/formulas/${ids.tincture}`);
  ids.component = (await get('SELECT output_material_id FROM formulas WHERE id = ?', ids.tincture)).output_material_id;
  const comp = await get('SELECT * FROM materials WHERE id = ?', ids.component);
  // 200 g @ $22/kg = $4.40 + 1 l @ $30 = $34.40 per 1000 ml.
  assert.equal(comp.pack_cost, 3440);
  assert.equal(comp.kind, 'component');
});

test('product recipe uses the component; batches deduct exact lots and carry actual cost', async () => {
  let res = await owner.post('/admin/products/new', { title: 'Testwort Tincture 30 ml', status: 'active', price: '18.00', track_inventory: '1', requires_shipping: '1', taxable: '1', inventory_qty: '0' }, '/admin/products/new');
  ids.product = Number(res.location.split('/').pop());
  ids.variant = (await get('SELECT id FROM variants WHERE product_id = ?', ids.product)).id;
  await owner.post(`/admin/costing/products/${ids.product}/variants/${ids.variant}`, {
    'lines[0][material_id]': ids.component, 'lines[0][quantity]': '30', 'lines[0][unit]': 'ml',
    'lines[1][material_id]': ids.bottle, 'lines[1][quantity]': '1', 'lines[1][unit]': 'each',
    'lines[2][material_id]': ids.label, 'lines[2][quantity]': '1', 'lines[2][unit]': 'each', use_calculated: '1',
  }, `/admin/costing/products/${ids.product}`);
  // 30 ml @ $34.40/l = 103.2c + bottle 50c + label 5c = 158.2 -> 158c.
  assert.equal((await get('SELECT cost FROM variants WHERE id = ?', ids.variant)).cost, 158);

  // Bulk tincture batch: 1000 ml.
  res = await owner.post('/admin/production/new', { make: `formula:${ids.tincture}`, planned_qty: '1000', source: 'restock' }, '/admin/production/new');
  ids.bulk = Number(res.location.split('/').pop());
  const b = `/admin/production/${ids.bulk}`;
  await owner.post(`${b}/start`, {}, b);
  await owner.post(`${b}/complete`, { actual_qty: '1000' }, b);
  assert.equal((await get('SELECT status FROM production_batches WHERE id = ?', ids.bulk)).status, 'in_progress', 'QC must pass first');
  const checks = await all('SELECT id FROM production_quality_checks WHERE batch_id = ?', ids.bulk);
  const body = {};
  for (const c of checks) body[`checks[id${c.id}][result]`] = 'pass';
  await owner.post(`${b}/checks`, body, b);
  await owner.post(`${b}/complete`, { actual_qty: '980', waste_qty: '20' }, b);
  const done = await get('SELECT * FROM production_batches WHERE id = ?', ids.bulk);
  assert.equal(done.status, 'completed');
  // First-expiring herb lot (2030) is used first.
  const herbUse = await all('SELECT i.*, l.supplier_lot FROM production_batch_inputs i JOIN material_lots l ON l.id = i.lot_id WHERE i.batch_id = ? AND i.material_id = ?', ids.bulk, ids.herb);
  assert.deepEqual(herbUse.map((i) => i.supplier_lot), ['SUP-A1']);
  assert.equal(Number(herbUse[0].used_qty), 200);
  // Actual = herb lot landed cost (≈ $22 + shipping share)/kg × 0.2 + alcohol landed × 1 l.
  const lots = await all('SELECT i.used_qty, i.unit_cost FROM production_batch_inputs i WHERE batch_id = ?', ids.bulk);
  near(done.actual_cost, Math.round(lots.reduce((s, l) => s + Number(l.used_qty) * Number(l.unit_cost), 0)), 1);
  assert.ok(done.actual_cost > done.estimated_cost, 'landed shipping makes the actual cost higher than the estimate');
  const out = await get('SELECT * FROM material_lots WHERE production_batch_id = ?', ids.bulk);
  assert.equal(out.status, 'quarantine');
  assert.equal(Number(out.qty_received), 980);

  // A product batch can't use quarantined tincture.
  res = await owner.post('/admin/production/new', { make: `variant:${ids.variant}`, planned_qty: '10' }, '/admin/production/new');
  ids.bottling = Number(res.location.split('/').pop());
  const p = `/admin/production/${ids.bottling}`;
  const pchecks = await all('SELECT id FROM production_quality_checks WHERE batch_id = ?', ids.bottling);
  const pbody = {};
  for (const c of pchecks) pbody[`checks[id${c.id}][result]`] = 'na';
  await owner.post(`${p}/start`, {}, p);
  await owner.post(`${p}/checks`, pbody, p);
  await owner.post(`${p}/complete`, { actual_qty: '10' }, p);
  assert.equal((await get('SELECT status FROM production_batches WHERE id = ?', ids.bottling)).status, 'in_progress', 'not enough released tincture');
  assert.equal(Number((await get('SELECT qty_remaining FROM material_lots WHERE material_id = ? AND status = ? LIMIT 1', ids.bottle, 'available')).qty_remaining), 200, 'nothing was deducted after the failure');

  await owner.post(`${b}/release`, {}, b);
  assert.equal((await get('SELECT status FROM material_lots WHERE id = ?', out.id)).status, 'available');
  await owner.post(`${p}/complete`, { actual_qty: '10' }, p);
  const bottled = await get('SELECT * FROM production_batches WHERE id = ?', ids.bottling);
  assert.equal(bottled.status, 'completed');
  assert.equal(Number((await get('SELECT qty_remaining FROM material_lots WHERE id = ?', out.id)).qty_remaining), 680, '300 ml of tincture used');
  const fg = await get('SELECT * FROM finished_goods_lots WHERE batch_id = ?', ids.bottling);
  assert.equal(fg.status, 'quarantine');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', ids.variant)).inventory_qty, 0, 'not sellable until released');
  await owner.post(`${p}/release`, {}, p);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', ids.variant)).inventory_qty, 10);
  ids.fg = fg.id;
  ids.fgCost = Number(fg.unit_cost);
  for (const url of [b, `${b}/record`, `${b}/labels`, p, `${p}/record`, `${p}/labels?count=5`, '/admin/production', `/admin/costing/products/${ids.product}`]) {
    assert.equal((await owner.get(url)).status, 200, url);
  }
  assert.match((await owner.get(`/admin/costing/products/${ids.product}`)).text, /Actual cost per unit/);
});

test('sales draw from batch lots at actual cost; restock returns units; tracing finds the orders', async () => {
  const pricing = require('../src/pricing');
  const orders = require('../src/orders');
  const cart = await pricing.buildCart([{ variant_id: ids.variant, quantity: 3 }]);
  const totals = await pricing.computeTotals(cart, {});
  const order = await orders.createOrder({ cart, totals, contact: { email: 'buyer@example.com' }, shippingAddress: {}, payment: { name: 'Test' } });
  const item = await get('SELECT * FROM order_items WHERE order_id = ?', order.id);
  assert.equal(item.unit_cost, Math.round(ids.fgCost));
  assert.equal((await get('SELECT qty_remaining FROM finished_goods_lots WHERE id = ?', ids.fg)).qty_remaining, 7);
  const herbLot = await get("SELECT id FROM material_lots WHERE supplier_lot = 'SUP-A1'");
  const trace = await owner.get(`/admin/production/trace?lot=${herbLot.id}`);
  assert.match(trace.text, new RegExp(`#${order.number}`));
  assert.match(trace.text, /Testwort Tincture 30 ml/);
  const byBatch = await owner.get(`/admin/production/trace?batch=${ids.bottling}`);
  assert.match(byBatch.text, /SUP-A1/);
  assert.match(byBatch.text, new RegExp(`Order #${order.number}`));
  assert.equal((await owner.get('/admin/production/trace?q=SUP-A1')).location, `/admin/production/trace?lot=${herbLot.id}`);
  await orders.cancel(order.id, { restock: true, notify: false });
  assert.equal((await get('SELECT qty_remaining FROM finished_goods_lots WHERE id = ?', ids.fg)).qty_remaining, 10);
  ids.herbLot = herbLot.id;
});

test('a supplier price rise flows through the formula component to the product cost', async () => {
  const before = (await get('SELECT cost FROM variants WHERE id = ?', ids.variant)).cost;
  await owner.post(`/admin/costing/materials/${ids.herb}`, { name: 'Testwort leaf', kind: 'herb', pack_size: '1', pack_unit: 'kg', pack_cost: '42.00', stock_unit: 'g' }, `/admin/costing/materials/${ids.herb}`);
  // Tincture: 200 g @ $42/kg = $8.40 + $30 = $38.40/l -> 30 ml = 115.2c + 55c = 170c.
  assert.equal((await get('SELECT pack_cost FROM materials WHERE id = ?', ids.component)).pack_cost, 3840);
  const after = (await get('SELECT cost FROM variants WHERE id = ?', ids.variant)).cost;
  assert.equal(after, 170);
  assert.ok(after > before);
});

test('recall marks downstream lots and pulls unsold stock', async () => {
  const p = `/admin/production/trace?lot=${ids.herbLot}`;
  await owner.post(`/admin/production/trace/lot/${ids.herbLot}/recall`, { reason: 'Test recall' }, p);
  assert.equal((await get('SELECT status FROM material_lots WHERE id = ?', ids.herbLot)).status, 'available', 'confirmation required');
  await owner.post(`/admin/production/trace/lot/${ids.herbLot}/recall`, { reason: 'Test recall', confirm: '1' }, p);
  assert.equal((await get('SELECT status FROM material_lots WHERE id = ?', ids.herbLot)).status, 'recalled');
  assert.equal((await get('SELECT status FROM material_lots WHERE production_batch_id = ?', ids.bulk)).status, 'recalled', 'the tincture made from it');
  assert.equal((await get('SELECT status FROM finished_goods_lots WHERE id = ?', ids.fg)).status, 'recalled');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', ids.variant)).inventory_qty, 0);
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'lot.recalled'"));
});

test('apothecary permissions and private formulas', async () => {
  await owner.post('/admin/settings/staff', { name: 'Pip Practitioner', email: 'pip@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  const pip = new Client(ctx.base);
  await pip.post('/admin/login', { email: 'pip@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal((await pip.get('/admin/formulas')).status, 200);
  assert.equal((await pip.get('/admin/inventory')).status, 403);
  assert.equal((await pip.get('/admin/production')).status, 403);
  const res = await pip.post('/admin/formulas/new', { name: 'Pip private blend', category: 'tea', entry_mode: 'parts', yield_qty: '100', yield_unit: 'g', visibility: 'private', 'lines[0][material_id]': ids.flower, 'lines[0][quantity]': '1' }, '/admin/formulas/new');
  const id = Number(res.location.split('/').pop());
  assert.equal((await pip.get(`/admin/formulas/${id}`)).status, 200);
  assert.equal((await owner.get(`/admin/formulas/${id}`)).status, 404, 'private to its author');
  await pip.post(`/admin/formulas/${id}/approve`, { reviewed_safety: '1' }, `/admin/formulas/${id}`);
  assert.equal((await get('SELECT status FROM formulas WHERE id = ?', id)).status, 'draft', 'practitioners cannot approve by default');
});
