'use strict';
// Apothecary inventory, Craftybase-style: every purchase becomes a lot with its own landed unit
// cost; production consumes lots first-expiring-first, then oldest-first, so each batch carries its
// actual cost. Quantities are base units (g, ml, each); unit costs are cents per base unit.
const { get, all, run, insert, tx } = require('./db');
const settings = require('./settings');
const costing = require('./costing');

const { UNITS } = costing;
const base = (qty, unit) => Number(qty) * UNITS[unit].factor;
const fromBase = (qty, unit) => Number(qty) / UNITS[unit].factor;
const baseUnitOf = (unit) => ({ mass: 'g', volume: 'ml', count: 'each' })[UNITS[unit].type];
const stockUnit = (m) => (m.stock_unit && UNITS[m.stock_unit] && UNITS[m.stock_unit].type === UNITS[m.pack_unit].type ? m.stock_unit : m.pack_unit);

// "1,250 g" style display of a base quantity in the material's stock unit.
function fmtQty(qtyBase, m) {
  const unit = stockUnit(m);
  const v = fromBase(qtyBase, unit);
  const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  return `${rounded.toLocaleString('en-US')} ${UNITS[unit].label}`;
}

const err = (message, status = 409) => Object.assign(new Error(message), { status });

async function nextLotCode(materialId, prefix = 'L') {
  const day = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const n = (await get('SELECT COUNT(*) AS n FROM material_lots WHERE material_id = ? AND lot_code LIKE ?', materialId, `${prefix}${day}-%`)).n + 1;
  return `${prefix}${day}-${materialId}-${n}`;
}

async function recordTx({ material_id, lot_id = null, kind, qty, value, reason = '', batchId = null, poId = null, staff = '' }) {
  await run(`INSERT INTO inventory_transactions (material_id, lot_id, kind, qty, value, reason, production_batch_id, purchase_order_id, staff_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, material_id, lot_id, kind, qty, Math.round(value), reason, batchId, poId, staff);
}

/** Adds a lot. qty_base in base units; unit_cost in cents per base unit. Returns the lot id. */
async function receiveLot(l) {
  return tx(async () => {
    const lotCode = String(l.lot_code || '').trim() || await nextLotCode(l.material_id, l.prefix || 'L');
    if (await get('SELECT 1 FROM material_lots WHERE material_id = ? AND lot_code = ?', l.material_id, lotCode)) throw err(`Lot ${lotCode} already exists for this material.`);
    const id = await insert(`INSERT INTO material_lots (material_id, lot_code, supplier_lot, supplier_id, purchase_order_item_id, production_batch_id, location_id,
        received_at, harvest_date, expires_at, organic, quality_notes, qty_received, qty_remaining, unit_cost, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, now()), ?, ?, ?, ?, ?, ?, ?, ?)`, l.material_id, lotCode, l.supplier_lot || '', l.supplier_id || null,
    l.po_item_id || null, l.batch_id || null, l.location_id || null, l.received_at || null, l.harvest_date || null, l.expires_at || null, l.organic ? 1 : 0,
    l.quality_notes || '', l.qty_base, l.qty_base, l.unit_cost, l.status || 'available');
    await recordTx({ material_id: l.material_id, lot_id: id, kind: l.kind || 'receive', qty: l.qty_base, value: l.qty_base * l.unit_cost, reason: l.reason || '', batchId: l.batch_id, poId: l.po_id, staff: l.staff });
    return id;
  });
}

// Lots a consumption would draw from: earliest expiry first, then oldest.
async function availableLots(materialId) {
  return all(`SELECT * FROM material_lots WHERE material_id = ? AND status = 'available' AND qty_remaining > 0
    ORDER BY expires_at NULLS LAST, received_at, id`, materialId);
}

/**
 * Takes qtyBase of a material out of stock. With lotId, only that lot is used; otherwise FEFO/FIFO.
 * Returns [{ lot_id, qty, unit_cost }]. Throws 409 when there isn't enough available stock.
 */
async function consume(materialId, qtyBase, { lotId = null, kind = 'production_use', batchId = null, reason = '', staff = '' } = {}) {
  return tx(async () => {
    const lots = lotId
      ? await all("SELECT * FROM material_lots WHERE id = ? AND material_id = ? AND status = 'available' FOR UPDATE", lotId, materialId)
      : await all(`SELECT * FROM material_lots WHERE material_id = ? AND status = 'available' AND qty_remaining > 0
          ORDER BY expires_at NULLS LAST, received_at, id FOR UPDATE`, materialId);
    let need = Number(qtyBase);
    const taken = [];
    for (const lot of lots) {
      if (need <= 1e-9) break;
      const q = Math.min(need, Number(lot.qty_remaining));
      if (q <= 0) continue;
      const left = Number(lot.qty_remaining) - q;
      await run(`UPDATE material_lots SET qty_remaining = ?, status = CASE WHEN ? <= 0.00005 THEN 'depleted' ELSE status END WHERE id = ?`, Math.max(0, left), left, lot.id);
      await recordTx({ material_id: materialId, lot_id: lot.id, kind, qty: -q, value: -q * Number(lot.unit_cost), reason, batchId, staff });
      taken.push({ lot_id: lot.id, lot_code: lot.lot_code, qty: q, unit_cost: Number(lot.unit_cost) });
      need -= q;
    }
    if (need > 1e-6) {
      const m = await get('SELECT * FROM materials WHERE id = ?', materialId);
      throw err(`Not enough ${m.name} in stock: short by ${fmtQty(need, m)}${lotId ? ' in the chosen lot' : ''}.`);
    }
    return taken;
  });
}

// Manual stock changes on one lot. kind: adjustment (+/-), waste (-), count (set to counted qty).
async function adjustLot(lotId, { kind, qtyBase, reason, staff }) {
  return tx(async () => {
    const lot = await get('SELECT * FROM material_lots WHERE id = ? FOR UPDATE', lotId);
    if (!lot) throw err('Lot not found.', 404);
    const current = Number(lot.qty_remaining);
    let delta;
    if (kind === 'count') delta = Number(qtyBase) - current;
    else if (kind === 'waste') delta = -Math.abs(Number(qtyBase));
    else delta = Number(qtyBase);
    const next = current + delta;
    if (next < -1e-9) throw err('That would take the lot below zero.');
    if (!reason) throw err('Give a reason for the adjustment.', 422);
    await run(`UPDATE material_lots SET qty_remaining = ?, status = CASE WHEN status IN ('available', 'depleted') THEN (CASE WHEN ? <= 0.00005 THEN 'depleted' ELSE 'available' END) ELSE status END WHERE id = ?`,
      Math.max(0, next), next, lotId);
    await recordTx({ material_id: lot.material_id, lot_id: lotId, kind, qty: delta, value: delta * Number(lot.unit_cost), reason, staff });
    return delta;
  });
}

async function moveLot(lotId, locationId, staff) {
  const lot = await get('SELECT * FROM material_lots WHERE id = ?', lotId);
  if (!lot) throw err('Lot not found.', 404);
  await run('UPDATE material_lots SET location_id = ? WHERE id = ?', locationId || null, lotId);
  const loc = locationId ? (await get('SELECT name FROM inventory_locations WHERE id = ?', locationId)).name : 'no location';
  await recordTx({ material_id: lot.material_id, lot_id: lotId, kind: 'transfer', qty: 0, value: 0, reason: `Moved to ${loc}`, staff });
}

/* ---------- Purchase orders ---------- */

async function nextPoNumber() {
  return ((await get('SELECT MAX(number) AS n FROM purchase_orders')).n || 1000) + 1;
}

async function poTotals(poId) {
  const po = await get('SELECT * FROM purchase_orders WHERE id = ?', poId);
  const items = await all(`SELECT i.*, m.name, m.pack_unit AS material_unit FROM purchase_order_items i JOIN materials m ON m.id = i.material_id WHERE purchase_order_id = ? ORDER BY i.id`, poId);
  for (const i of items) {
    i.ordered_base = base(Number(i.packs) * Number(i.pack_size), i.pack_unit);
    i.line_total = Math.round(Number(i.packs) * i.pack_cost);
    i.received_base = Number(i.received_base);
  }
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  return { po, items, subtotal, total: subtotal + po.shipping_cost + po.tax_cost };
}

/**
 * Receives quantities against a purchase order. lines: [{ item_id, packs, lot_code, supplier_lot,
 * expires_at, harvest_date, location_id, organic, quality_notes }]. Shipping and tax are spread over
 * the order by line value (landed cost), the supplier's latest pack price becomes the material's
 * price (recalculating product costs), and the order is marked partly or fully received.
 */
async function receivePurchaseOrder(poId, lines, staff) {
  return tx(async () => {
    const { po, items, subtotal } = await poTotals(poId);
    if (!po || ['received', 'cancelled'].includes(po.status)) throw err('This purchase order can no longer be received.');
    const extras = po.shipping_cost + po.tax_cost;
    const received = [];
    for (const line of lines) {
      const item = items.find((i) => i.id === Number(line.item_id));
      const packs = Number(line.packs);
      if (!item || !(packs > 0)) continue;
      const qtyBase = base(packs * Number(item.pack_size), item.pack_unit);
      const goods = packs * item.pack_cost;
      const share = subtotal > 0 ? (item.line_total / subtotal) * extras * (packs / Number(item.packs)) : 0;
      const unitCost = (goods + share) / qtyBase;
      const lotId = await receiveLot({
        material_id: item.material_id, qty_base: qtyBase, unit_cost: unitCost, lot_code: line.lot_code, supplier_lot: line.supplier_lot,
        supplier_id: po.supplier_id, po_item_id: item.id, po_id: po.id, location_id: line.location_id, expires_at: line.expires_at || null,
        harvest_date: line.harvest_date || null, organic: line.organic, quality_notes: line.quality_notes, staff, reason: `PO #${po.number}`,
      });
      await run('UPDATE purchase_order_items SET received_base = received_base + ? WHERE id = ?', qtyBase, item.id);
      // The latest purchase price becomes the material's replacement price used for estimates.
      const m = await get('SELECT * FROM materials WHERE id = ?', item.material_id);
      if (m.pack_cost !== item.pack_cost || Number(m.pack_size) !== Number(item.pack_size) || m.pack_unit !== item.pack_unit) {
        await run('UPDATE materials SET pack_cost = ?, pack_size = ?, pack_unit = ?, updated_at = now() WHERE id = ?', item.pack_cost, item.pack_size, item.pack_unit, m.id);
        await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)', m.id, item.pack_size, item.pack_unit, item.pack_cost, `${staff} (PO #${po.number})`);
        await costing.recalcForMaterial(m.id);
      }
      received.push(lotId);
    }
    if (!received.length) throw err('Enter a quantity received for at least one line.', 422);
    const after = await all('SELECT packs, pack_size, pack_unit, received_base FROM purchase_order_items WHERE purchase_order_id = ?', po.id);
    const complete = after.every((i) => Number(i.received_base) + 1e-6 >= base(Number(i.packs) * Number(i.pack_size), i.pack_unit));
    await run(`UPDATE purchase_orders SET status = ?, received_at = ${complete ? 'now()' : 'received_at'} WHERE id = ?`, complete ? 'received' : 'partial', po.id);
    return received;
  });
}

/* ---------- Reporting ---------- */

async function stockSummary({ q = '', kind = '', filter = '' } = {}) {
  const where = ['m.archived = 0'];
  const params = [];
  if (q) { where.push('(m.name ILIKE ? OR m.botanical_name ILIKE ? OR m.sku ILIKE ? OR EXISTS (SELECT 1 FROM material_lots l WHERE l.material_id = m.id AND (l.lot_code ILIKE ? OR l.supplier_lot ILIKE ?)))'); params.push(...Array(5).fill(`%${q}%`)); }
  if (kind) { where.push('m.kind = ?'); params.push(kind); }
  const rows = await all(`SELECT m.*, s.name AS supplier_name,
      COALESCE((SELECT SUM(qty_remaining) FROM material_lots l WHERE l.material_id = m.id AND l.status = 'available'), 0) AS on_hand,
      COALESCE((SELECT SUM(qty_remaining) FROM material_lots l WHERE l.material_id = m.id AND l.status = 'quarantine'), 0) AS quarantined,
      COALESCE((SELECT SUM(qty_remaining * unit_cost) FROM material_lots l WHERE l.material_id = m.id AND l.status IN ('available', 'quarantine')), 0) AS value,
      (SELECT MIN(expires_at) FROM material_lots l WHERE l.material_id = m.id AND l.status = 'available' AND l.qty_remaining > 0) AS next_expiry
    FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE ${where.join(' AND ')} ORDER BY lower(m.name)`, ...params);
  const warnDays = Number(settings.load('inventory').expiry_warning_days) || 60;
  const soon = new Date(Date.now() + warnDays * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    r.on_hand = Number(r.on_hand); r.value = Math.round(Number(r.value)); r.quarantined = Number(r.quarantined);
    r.reorder_point = r.reorder_point === null ? null : Number(r.reorder_point);
    r.low = r.track_stock && r.reorder_point !== null && r.on_hand <= r.reorder_point;
    const exp = r.next_expiry ? (r.next_expiry instanceof Date ? r.next_expiry.toISOString() : String(r.next_expiry)).slice(0, 10) : null;
    r.next_expiry = exp;
    r.expired = exp && exp < today;
    r.expiring = exp && !r.expired && exp <= soon;
  }
  const filtered = rows.filter((r) => (filter === 'low' ? r.low : filter === 'expiring' ? r.expired || r.expiring : true));
  return { rows: filtered, totalValue: rows.reduce((s, r) => s + r.value, 0), warnDays };
}

async function alerts() {
  const { rows, warnDays } = await stockSummary();
  return { low: rows.filter((r) => r.low), expiring: rows.filter((r) => r.expiring || r.expired), warnDays };
}

async function finishedGoodsValue() {
  return Math.round(Number((await get("SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS v FROM finished_goods_lots WHERE status IN ('available', 'quarantine')")).v));
}

module.exports = {
  UNITS, base, fromBase, baseUnitOf, stockUnit, fmtQty, nextLotCode, receiveLot, availableLots, consume, adjustLot, moveLot,
  nextPoNumber, poTotals, receivePurchaseOrder, stockSummary, alerts, finishedGoodsValue, recordTx,
};
