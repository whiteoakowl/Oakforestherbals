'use strict';
// Charting (body chart, tongue, pulse) and dispensing remedies from the client record.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, insert } = require('../src/db');
const vault = require('../src/vault');
const inventory = require('../src/inventory');

let ctx;
let ann;
let base;
const ids = {};

before(async () => {
  ctx = await start();
  const owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  ann = new Client(ctx.base);
  await ann.post('/admin/login', { email: 'ann@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  const res = await ann.post('/admin/clinic/patients/new', { email: 'fern@example.com', first_name: 'Fern', last_name: 'Vale', consent: '1' }, '/admin/clinic/patients/new');
  ids.patient = Number(res.location.split('/').pop());
  base = `/admin/clinic/patients/${ids.patient}`;
  await ann.post(`${base}/health`, { category: 'allergy', name: 'Ragweed' }, `${base}?tab=health`);
  // A 1:5 tincture formula: 20 g herb in 100 ml.
  const herb = await insert("INSERT INTO materials (name, kind, pack_size, pack_unit, pack_cost) VALUES ('Chamomile flower', 'herb', 1000, 'g', 4000)");
  const menstruum = await insert("INSERT INTO materials (name, kind, pack_size, pack_unit, pack_cost) VALUES ('Alcohol 40%', 'other', 1000, 'ml', 2000)");
  ids.formula = await insert("INSERT INTO formulas (name, category, entry_mode, yield_qty, yield_unit, visibility, owner_id, status) VALUES ('Calm tincture', 'tincture', 'amount', 100, 'ml', 'shared', NULL, 'approved')");
  await insert("INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, position) VALUES (?, ?, 20, 'g', 0)", ids.formula, herb);
  await insert("INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, position) VALUES (?, ?, 100, 'ml', 1)", ids.formula, menstruum);
  await inventory.receiveLot({ material_id: herb, lot_code: 'CH-OLD', qty_base: 30, unit_cost: 4, expires_at: '2027-01-01' });
  await inventory.receiveLot({ material_id: herb, lot_code: 'CH-NEW', qty_base: 500, unit_cost: 5, expires_at: '2028-01-01' });
  await inventory.receiveLot({ material_id: menstruum, lot_code: 'ALC-1', qty_base: 1000, unit_cost: 2 });
  Object.assign(ids, { herb, menstruum });
});
after(() => ctx.close());

test('a note can carry a body chart, tongue and pulse, stored encrypted and shown back', async () => {
  const chart = JSON.stringify([{ view: 'front', x: 25, y: 40, label: 'Epigastric tightness' }, { view: 'back', x: 75, y: 30, label: 'Upper back tension 6/10' }, { x: 999, y: -5 }]);
  await ann.post(`${base}/notes`, { kind: 'consultation', text: 'TCM intake', chart, tongue_body: 'Pale', tongue_coating: 'Thin white', pulse_rate: '68', pulse_left_guan: 'Wiry', sign: '1' }, `${base}?tab=notes`);
  const note = await get('SELECT * FROM clinical_notes WHERE patient_id = ?', ids.patient);
  assert.doesNotMatch(note.body_enc, /Epigastric|Wiry/);
  const body = vault.open(note.body_enc);
  assert.equal(body.chart.length, 3);
  assert.deepEqual(body.chart[2], { view: 'front', x: 100, y: 0, label: '' }, 'out-of-range coordinates are clamped');
  assert.equal(body.tongue.body, 'Pale');
  assert.equal(body.pulse.left_guan, 'Wiry');
  const page = await ann.get(`${base}?tab=notes`);
  assert.match(page.text, /Upper back tension 6\/10/);
  assert.match(page.text, /Thin white/);
  assert.match(page.text, /Left guan/);
  assert.match(page.text, /class="marker"/);
});

test('dispensing scales the formula, shows a safety check, and takes stock oldest-expiry first', async () => {
  let page = await ann.get(`${base}?tab=dispensary&formula=${ids.formula}&qty=200&unit=ml`);
  assert.match(page.text, /Chamomile flower<\/td><td class="num">40 g/);
  assert.match(page.text, /Alcohol 40%<\/td><td class="num">200 ml/);
  assert.match(page.text, /allergies — Ragweed/);
  assert.match(page.text, /Before you dispense/);
  page = await ann.get(`${base}?tab=dispensary&formula=${ids.formula}&qty=200&unit=each`);
  assert.match(page.text, /can’t be converted/);

  const res = await ann.post(`${base}/dispense`, { formula_id: String(ids.formula), qty: '200', unit: 'ml', instructions: '5 ml twice daily', price: '24.00', take_stock: '1' }, `${base}?tab=dispensary`);
  assert.match(res.location, /tab=dispensary#dispensing-\d+/);
  const d = await get('SELECT * FROM dispensings WHERE patient_id = ?', ids.patient);
  assert.match(d.code, /^D-\d{6}-/);
  assert.doesNotMatch(d.instructions_enc, /twice daily/);
  // 40 g herb: all 30 g of the older lot, then 10 g of the newer one; cost from the actual lots.
  const lots = JSON.parse(d.lots);
  assert.deepEqual(lots.filter((l) => l.material === 'Chamomile flower').map((l) => [l.lot, l.qty]), [['CH-OLD', 30], ['CH-NEW', 10]]);
  assert.equal(d.cost, 30 * 4 + 10 * 5 + 200 * 2);
  assert.equal(d.price, 2400);
  assert.equal(Number((await get("SELECT qty_remaining FROM material_lots WHERE lot_code = 'CH-OLD'")).qty_remaining), 0);
  assert.ok(await get("SELECT 1 FROM inventory_transactions WHERE kind = 'dispense' AND reason LIKE ?", `%${d.code}%`));
  const label = await ann.get(`${base}/dispensings/${d.id}/label`);
  assert.match(label.text, /Calm tincture — 200 ml/);
  assert.match(label.text, /For: <strong>Fern Vale/);
  assert.match(label.text, /5 ml twice daily/);
  assert.match(label.text, /Keep out of reach of children/);
});

test('dispensing more than is in stock changes nothing', async () => {
  const before = await all('SELECT id, qty_remaining FROM material_lots ORDER BY id');
  const res = await ann.post(`${base}/dispense`, { formula_id: String(ids.formula), qty: '5', unit: 'l', take_stock: '1' }, `${base}?tab=dispensary`);
  assert.match(res.location, /tab=dispensary&formula=/);
  assert.equal((await all('SELECT id FROM dispensings')).length, 1);
  assert.deepEqual(await all('SELECT id, qty_remaining FROM material_lots ORDER BY id'), before);
  const page = await ann.get(res.location);
  assert.match(page.text, /Not enough/);
});
