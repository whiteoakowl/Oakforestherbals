'use strict';
// Apothecary → Inventory: stock on hand by lot, receiving, adjustments, suppliers, purchase orders.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const inventory = require('../../inventory');
const costing = require('../../costing');
const settings = require('../../settings');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, parseMoney, csvRow, centsToInput, asList } = require('../../utils');

const router = express.Router();
const { UNITS } = inventory;

router.use((req, res, next) => {
  Object.assign(res.locals, { UNITS, KINDS: costing.KINDS, fmtQty: inventory.fmtQty, stockUnit: inventory.stockUnit, fromBase: inventory.fromBase });
  next();
});

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const text = (v, max = 2000) => String(v || '').trim().slice(0, max);
const fail = (req, res, msg, to) => { flash(req, 'error', msg); return res.redirect(to); };
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
router.use((req, res, next) => { res.locals.ymd = ymd; next(); });

/* ---------- Stock ---------- */

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kind = costing.KINDS.some(([k]) => k === req.query.kind) ? req.query.kind : '';
  const filter = ['low', 'expiring'].includes(req.query.filter) ? req.query.filter : '';
  const summary = await inventory.stockSummary({ q, kind, filter });
  const all_ = await inventory.stockSummary();
  res.render('admin/inventory/index', {
    title: 'Inventory', ...summary, q, kind, filter, finishedValue: await inventory.finishedGoodsValue(),
    lowCount: all_.rows.filter((r) => r.low).length, expiringCount: all_.rows.filter((r) => r.expiring || r.expired).length, s: settings.load('inventory'),
  });
});

router.post('/settings', async (req, res) => {
  const days = Math.max(1, Math.min(730, toInt(req.body.expiry_warning_days, 60)));
  await settings.save('inventory', { expiry_warning_days: days });
  flash(req, 'success', 'Inventory settings saved.');
  res.redirect('/admin/inventory');
});

router.get('/export.csv', async (req, res) => {
  const { rows } = await inventory.stockSummary();
  const lines = [csvRow(['Material', 'Botanical name', 'Type', 'SKU', 'On hand', 'Unit', 'Quarantined', 'Value', 'Reorder point', 'Next expiry', 'Supplier'])];
  for (const r of rows) {
    const u = inventory.stockUnit(r);
    lines.push(csvRow([r.name, r.botanical_name, r.kind, r.sku, Math.round(inventory.fromBase(r.on_hand, u) * 1000) / 1000, UNITS[u].label,
      Math.round(inventory.fromBase(r.quarantined, u) * 1000) / 1000, centsToInput(r.value),
      r.reorder_point === null ? '' : Math.round(inventory.fromBase(r.reorder_point, u) * 1000) / 1000, r.next_expiry || '', r.supplier_name || '']));
  }
  res.attachment('inventory.csv').type('text/csv').send(lines.join('\n'));
});

async function materialParam(req, res, next) {
  const m = await get('SELECT m.*, s.name AS supplier_name FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE m.id = ?', toInt(req.params.id));
  if (!m) return res.status(404).render('admin/error', { title: 'Not found', message: 'This material does not exist.' });
  m.pack_size = Number(m.pack_size);
  req.material = m;
  next();
}

router.get('/materials/:id', materialParam, async (req, res) => {
  const m = req.material;
  const [lots, txs, locations, suppliers] = await Promise.all([
    all(`SELECT l.*, loc.name AS location, s.name AS supplier, b.code AS batch_code FROM material_lots l LEFT JOIN inventory_locations loc ON loc.id = l.location_id
      LEFT JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN production_batches b ON b.id = l.production_batch_id
      WHERE l.material_id = ? ORDER BY (l.qty_remaining > 0) DESC, l.expires_at NULLS LAST, l.received_at DESC, l.id DESC LIMIT 100`, m.id),
    all(`SELECT t.*, l.lot_code, b.code AS batch_code, po.number AS po_number FROM inventory_transactions t LEFT JOIN material_lots l ON l.id = t.lot_id
      LEFT JOIN production_batches b ON b.id = t.production_batch_id LEFT JOIN purchase_orders po ON po.id = t.purchase_order_id
      WHERE t.material_id = ? ORDER BY t.id DESC LIMIT 60`, m.id),
    all('SELECT * FROM inventory_locations ORDER BY name'),
    all('SELECT id, name FROM suppliers WHERE archived = 0 ORDER BY lower(name)'),
  ]);
  const onHand = lots.filter((l) => l.status === 'available').reduce((s, l) => s + Number(l.qty_remaining), 0);
  const value = lots.filter((l) => ['available', 'quarantine'].includes(l.status)).reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0);
  const avg = onHand ? lots.filter((l) => l.status === 'available').reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0) / onHand : null;
  res.render('admin/inventory/material', { title: m.name, m, lots, txs, locations, suppliers, onHand, value: Math.round(value), avg });
});

router.post('/materials/:id/receive', materialParam, async (req, res) => {
  const m = req.material;
  const back = `/admin/inventory/materials/${m.id}`;
  const qty = num(req.body.qty);
  const unit = UNITS[req.body.unit] && UNITS[req.body.unit].type === UNITS[m.pack_unit].type ? req.body.unit : m.pack_unit;
  const cost = parseMoney(req.body.total_cost);
  if (!(qty > 0)) return fail(req, res, 'Enter the quantity received.', back);
  if (cost === null || cost < 0) return fail(req, res, 'Enter what you paid for this quantity (0 or more), including shipping if you want it in the cost.', back);
  const qtyBase = inventory.base(qty, unit);
  try {
    await inventory.receiveLot({
      material_id: m.id, qty_base: qtyBase, unit_cost: cost / qtyBase, lot_code: text(req.body.lot_code, 60), supplier_lot: text(req.body.supplier_lot, 60),
      supplier_id: toInt(req.body.supplier_id) || m.supplier_id, location_id: toInt(req.body.location_id) || null, expires_at: dateOrNull(req.body.expires_at),
      harvest_date: dateOrNull(req.body.harvest_date), received_at: dateOrNull(req.body.received_at), organic: req.body.organic === '1',
      quality_notes: text(req.body.quality_notes), staff: res.locals.staff.name, reason: text(req.body.reason, 200) || 'Received',
    });
  } catch (e) {
    if (e.status) return fail(req, res, e.message, back);
    throw e;
  }
  // Optionally make this the new replacement price used for product cost estimates.
  if (req.body.update_price === '1') {
    await run('UPDATE materials SET pack_cost = ?, pack_size = ?, pack_unit = ?, updated_at = now() WHERE id = ?', cost, qty, unit, m.id);
    await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)', m.id, qty, unit, cost, res.locals.staff.name);
    const impact = await costing.recalcForMaterial(m.id);
    flash(req, 'success', `Stock received; ${impact.length} product cost(s) recalculated with the new price.`);
  } else flash(req, 'success', 'Stock received.');
  await audit.record(req, 'inventory.received', { entityType: 'material', entityId: m.id, details: { qty_base: qtyBase } });
  res.redirect(back);
});

async function lotParam(req, res, next) {
  const lot = await get('SELECT l.*, m.name, m.pack_unit, m.stock_unit FROM material_lots l JOIN materials m ON m.id = l.material_id WHERE l.id = ?', toInt(req.params.id || req.body.lot));
  if (!lot) return res.status(404).render('admin/error', { title: 'Not found', message: 'This lot does not exist.' });
  req.lot = lot;
  next();
}

router.post(['/lots/adjust', '/lots/:id/adjust'], lotParam, async (req, res) => {
  const lot = req.lot;
  const back = `/admin/inventory/materials/${lot.material_id}`;
  const kind = ['adjustment', 'waste', 'count'].includes(req.body.kind) ? req.body.kind : null;
  const qty = num(req.body.qty);
  if (!kind || qty === null || Number.isNaN(qty)) return fail(req, res, 'Choose the type of change and enter a quantity.', back);
  const unit = inventory.stockUnit(lot);
  try {
    const delta = await inventory.adjustLot(lot.id, { kind, qtyBase: inventory.base(qty, unit), reason: text(req.body.reason, 300), staff: res.locals.staff.name });
    await audit.record(req, `inventory.${kind}`, { entityType: 'lot', entityId: lot.id, details: { delta_base: delta, reason: text(req.body.reason, 300) } });
    flash(req, 'success', `Lot ${lot.lot_code} updated (${delta >= 0 ? '+' : '−'}${inventory.fmtQty(Math.abs(delta), lot)}).`);
  } catch (e) {
    if (e.status) return fail(req, res, e.message, back);
    throw e;
  }
  res.redirect(back);
});

router.post(['/lots/move', '/lots/:id/move'], lotParam, async (req, res) => {
  await inventory.moveLot(req.lot.id, toInt(req.body.location_id) || null, res.locals.staff.name);
  flash(req, 'success', 'Lot moved.');
  res.redirect(`/admin/inventory/materials/${req.lot.material_id}`);
});

router.post('/lots/:id/status', lotParam, async (req, res) => {
  const status = ['available', 'quarantine'].includes(req.body.status) ? req.body.status : null;
  if (status && req.lot.status !== 'recalled') {
    await run('UPDATE material_lots SET status = ? WHERE id = ?', Number(req.lot.qty_remaining) > 0 || status === 'quarantine' ? status : 'depleted', req.lot.id);
    await inventory.recordTx({ material_id: req.lot.material_id, lot_id: req.lot.id, kind: 'adjustment', qty: 0, value: 0, reason: status === 'quarantine' ? 'Put on hold (quarantine)' : 'Released from hold', staff: res.locals.staff.name });
  }
  res.redirect(`/admin/inventory/materials/${req.lot.material_id}`);
});

/* ---------- Locations ---------- */

router.get('/locations', async (req, res) => {
  const locations = await all(`SELECT loc.*, (SELECT COUNT(*) FROM material_lots l WHERE l.location_id = loc.id AND l.qty_remaining > 0) AS lots FROM inventory_locations loc ORDER BY name`);
  res.render('admin/inventory/locations', { title: 'Storage locations', locations });
});
router.post('/locations', async (req, res) => {
  const name = text(req.body.name, 100);
  if (name) await run('INSERT INTO inventory_locations (name, notes) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', name, text(req.body.notes, 300));
  res.redirect('/admin/inventory/locations');
});
router.post('/locations/:id/delete', async (req, res) => {
  const id = toInt(req.params.id);
  if ((await get('SELECT COUNT(*) AS n FROM material_lots WHERE location_id = ? AND qty_remaining > 0', id)).n) flash(req, 'error', 'Move the stock out of this location first.');
  else await run('DELETE FROM inventory_locations WHERE id = ?', id);
  res.redirect('/admin/inventory/locations');
});

/* ---------- Suppliers ---------- */

const SUPPLIER_COLS = ['name', 'contact_name', 'email', 'phone', 'website', 'address', 'certifications', 'min_order', 'notes'];
function readSupplier(body) {
  const s = Object.fromEntries(SUPPLIER_COLS.map((c) => [c, text(body[c], c === 'notes' || c === 'address' ? 2000 : 300)]));
  if (s.website && !/^https?:\/\//i.test(s.website)) s.website = `https://${s.website}`;
  s.lead_time_days = toInt(body.lead_time_days) || null;
  return s;
}

router.get('/suppliers', async (req, res) => {
  const suppliers = await all(`SELECT s.*, (SELECT COUNT(*) FROM materials m WHERE m.supplier_id = s.id) AS materials,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS orders,
      (SELECT COALESCE(SUM(l.qty_received * l.unit_cost), 0) FROM material_lots l WHERE l.supplier_id = s.id) AS spent
    FROM suppliers s WHERE s.archived = ? ORDER BY lower(s.name)`, req.query.archived === '1' ? 1 : 0);
  res.render('admin/inventory/suppliers', { title: 'Suppliers', suppliers, archived: req.query.archived === '1' });
});
router.get('/suppliers/new', (req, res) => res.render('admin/inventory/supplier', { title: 'Add supplier', supplier: null, materials: [], orders: [], lots: [] }));
router.post('/suppliers/new', async (req, res) => {
  const s = readSupplier(req.body);
  if (!s.name) return fail(req, res, 'A supplier needs a name.', '/admin/inventory/suppliers/new');
  const id = await insert(`INSERT INTO suppliers (${SUPPLIER_COLS.join(', ')}, lead_time_days) VALUES (${SUPPLIER_COLS.map(() => '?').join(', ')}, ?)`, ...SUPPLIER_COLS.map((c) => s[c]), s.lead_time_days);
  flash(req, 'success', 'Supplier added.');
  res.redirect(`/admin/inventory/suppliers/${id}`);
});
router.get('/suppliers/:id', async (req, res, next) => {
  const supplier = await get('SELECT * FROM suppliers WHERE id = ?', toInt(req.params.id));
  if (!supplier) return next();
  const [materials, orders, lots] = await Promise.all([
    all('SELECT id, name, pack_size, pack_unit, pack_cost, supplier_sku FROM materials WHERE supplier_id = ? ORDER BY lower(name)', supplier.id),
    all('SELECT * FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC LIMIT 30', supplier.id),
    all(`SELECT l.*, m.name, m.pack_unit, m.stock_unit FROM material_lots l JOIN materials m ON m.id = l.material_id WHERE l.supplier_id = ? ORDER BY l.received_at DESC LIMIT 30`, supplier.id),
  ]);
  res.render('admin/inventory/supplier', { title: supplier.name, supplier, materials, orders, lots });
});
router.post('/suppliers/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const s = readSupplier(req.body);
  if (!s.name) return fail(req, res, 'A supplier needs a name.', `/admin/inventory/suppliers/${id}`);
  await run(`UPDATE suppliers SET ${SUPPLIER_COLS.map((c) => `${c} = ?`).join(', ')}, lead_time_days = ?, archived = ? WHERE id = ?`, ...SUPPLIER_COLS.map((c) => s[c]), s.lead_time_days, req.body.archived === '1' ? 1 : 0, id);
  await run('UPDATE materials SET supplier = ? WHERE supplier_id = ?', s.name, id);
  flash(req, 'success', 'Supplier saved.');
  res.redirect(`/admin/inventory/suppliers/${id}`);
});

/* ---------- Purchase orders ---------- */

router.get('/purchase-orders', async (req, res) => {
  const status = ['draft', 'ordered', 'partial', 'received', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const orders = await all(`SELECT po.*, s.name AS supplier, (SELECT COALESCE(SUM(packs * pack_cost), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS subtotal,
      (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS lines
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id ${status ? 'WHERE po.status = ?' : ''} ORDER BY po.id DESC LIMIT 100`, ...(status ? [status] : []));
  res.render('admin/inventory/purchase-orders', { title: 'Purchase orders', orders, status });
});

router.get('/purchase-orders/new', async (req, res) => {
  const suppliers = await all('SELECT id, name FROM suppliers WHERE archived = 0 ORDER BY lower(name)');
  // Suggest reordering low-stock materials, Craftybase-style.
  const { rows } = await inventory.stockSummary({ filter: 'low' });
  res.render('admin/inventory/po-new', { title: 'New purchase order', suppliers, low: rows, supplierId: toInt(req.query.supplier) });
});

router.post('/purchase-orders/new', async (req, res) => {
  const supplierId = toInt(req.body.supplier_id) || null;
  const materialIds = [].concat(req.body.material_ids || []).map(toInt).filter(Boolean);
  const id = await tx(async () => {
    const poId = await insert('INSERT INTO purchase_orders (number, supplier_id, created_by, expected_at, notes) VALUES (?, ?, ?, ?, ?)',
      await inventory.nextPoNumber(), supplierId, res.locals.staff.name, dateOrNull(req.body.expected_at), text(req.body.notes));
    for (const mid of materialIds) {
      const m = await get('SELECT * FROM materials WHERE id = ?', mid);
      if (m) await run('INSERT INTO purchase_order_items (purchase_order_id, material_id, packs, pack_size, pack_unit, pack_cost) VALUES (?, ?, 1, ?, ?, ?)', poId, m.id, m.pack_size, m.pack_unit, m.pack_cost);
    }
    return poId;
  });
  await audit.record(req, 'purchase_order.created', { entityType: 'purchase_order', entityId: id });
  res.redirect(`/admin/inventory/purchase-orders/${id}`);
});

async function poParam(req, res, next) {
  const data = await inventory.poTotals(toInt(req.params.id));
  if (!data.po) return res.status(404).render('admin/error', { title: 'Not found', message: 'This purchase order does not exist.' });
  data.supplier = data.po.supplier_id ? await get('SELECT * FROM suppliers WHERE id = ?', data.po.supplier_id) : null;
  req.poData = data;
  next();
}

router.get('/purchase-orders/:id', poParam, async (req, res) => {
  const [materials, locations, suppliers, lots] = await Promise.all([
    all('SELECT id, name, pack_size, pack_unit, pack_cost FROM materials WHERE archived = 0 AND formula_id IS NULL ORDER BY lower(name)'),
    all('SELECT * FROM inventory_locations ORDER BY name'), all('SELECT id, name FROM suppliers WHERE archived = 0 ORDER BY lower(name)'),
    all('SELECT l.*, m.name, m.pack_unit, m.stock_unit FROM material_lots l JOIN materials m ON m.id = l.material_id JOIN purchase_order_items i ON i.id = l.purchase_order_item_id WHERE i.purchase_order_id = ? ORDER BY l.id', req.poData.po.id),
  ]);
  res.render('admin/inventory/purchase-order', { title: `PO #${req.poData.po.number}`, ...req.poData, materials, locations, suppliers, lots });
});

router.get('/purchase-orders/:id/print', poParam, (req, res) => res.render('admin/inventory/po-print', { title: `Purchase order #${req.poData.po.number}`, ...req.poData }));

router.post('/purchase-orders/:id', poParam, async (req, res) => {
  const { po } = req.poData;
  const back = `/admin/inventory/purchase-orders/${po.id}`;
  if (po.status !== 'draft') return fail(req, res, 'Only draft purchase orders can be edited.', back);
  await tx(async () => {
    await run('UPDATE purchase_orders SET supplier_id = ?, expected_at = ?, shipping_cost = ?, tax_cost = ?, reference = ?, notes = ? WHERE id = ?',
      toInt(req.body.supplier_id) || null, dateOrNull(req.body.expected_at), parseMoney(req.body.shipping_cost) || 0, parseMoney(req.body.tax_cost) || 0,
      text(req.body.reference, 100), text(req.body.notes), po.id);
    for (const line of asList(req.body.items)) {
      const itemId = toInt(line.id);
      if (line.remove === '1') { await run('DELETE FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?', itemId, po.id); continue; }
      const packs = num(line.packs); const size = num(line.pack_size); const cost = parseMoney(line.pack_cost);
      if (packs > 0 && size > 0 && cost !== null && UNITS[line.pack_unit]) {
        await run('UPDATE purchase_order_items SET packs = ?, pack_size = ?, pack_unit = ?, pack_cost = ? WHERE id = ? AND purchase_order_id = ?', packs, size, line.pack_unit, cost, itemId, po.id);
      }
    }
    const addId = toInt(req.body.add_material_id);
    if (addId) {
      const m = await get('SELECT * FROM materials WHERE id = ?', addId);
      if (m) await run('INSERT INTO purchase_order_items (purchase_order_id, material_id, packs, pack_size, pack_unit, pack_cost) VALUES (?, ?, 1, ?, ?, ?)', po.id, m.id, m.pack_size, m.pack_unit, m.pack_cost);
    }
  });
  flash(req, 'success', 'Purchase order saved.');
  res.redirect(back);
});

router.post('/purchase-orders/:id/status', poParam, async (req, res) => {
  const { po, items } = req.poData;
  const back = `/admin/inventory/purchase-orders/${po.id}`;
  const to = req.body.status;
  if (to === 'ordered' && po.status === 'draft') {
    if (!items.length) return fail(req, res, 'Add at least one line first.', back);
    await run("UPDATE purchase_orders SET status = 'ordered', ordered_at = CURRENT_DATE WHERE id = ?", po.id);
  } else if (to === 'cancelled' && ['draft', 'ordered'].includes(po.status)) {
    await run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", po.id);
  } else return fail(req, res, 'That change is not possible for this order.', back);
  await audit.record(req, `purchase_order.${to}`, { entityType: 'purchase_order', entityId: po.id });
  res.redirect(back);
});

router.post('/purchase-orders/:id/receive', poParam, async (req, res) => {
  const { po } = req.poData;
  const back = `/admin/inventory/purchase-orders/${po.id}`;
  const lines = asList(req.body.receive).map((l) => ({ ...l, packs: num(l.packs), expires_at: dateOrNull(l.expires_at), harvest_date: dateOrNull(l.harvest_date), location_id: toInt(l.location_id) || null, organic: l.organic === '1', lot_code: text(l.lot_code, 60), supplier_lot: text(l.supplier_lot, 60), quality_notes: text(l.quality_notes, 500) }));
  try {
    const lots = await inventory.receivePurchaseOrder(po.id, lines, res.locals.staff.name);
    await audit.record(req, 'purchase_order.received', { entityType: 'purchase_order', entityId: po.id, details: { lots: lots.length } });
    flash(req, 'success', `${lots.length} lot(s) received into stock.`);
  } catch (e) {
    if (e.status) return fail(req, res, e.message, back);
    throw e;
  }
  res.redirect(back);
});

module.exports = router;
