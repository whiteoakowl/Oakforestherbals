'use strict';
// Production batches: plan from an approved formula or a product's recipe, run quality checks,
// complete (deduct the exact lots used, in one transaction, and record actual cost), then release
// the output for use or sale. Finished products are tracked in lots, sold oldest-first, so every
// order line knows which batch it came from (recall tracing) and what it really cost.
const { get, all, run, insert, tx } = require('./db');
const settings = require('./settings');
const costing = require('./costing');
const inventory = require('./inventory');
const formulas = require('./formulas');

const STATUSES = [
  ['planned', 'Planned'], ['in_progress', 'In progress'], ['awaiting_qc', 'Awaiting quality review'], ['completed', 'Completed (quarantine)'],
  ['released', 'Released'], ['archived', 'Archived'], ['cancelled', 'Cancelled'],
];
const SOURCES = [['manual', 'Manual request'], ['restock', 'Scheduled restock'], ['order', 'Product order'], ['care_plan', 'Patient care plan'], ['formula', 'Saved formula']];
const err = (message, status = 409) => Object.assign(new Error(message), { status });

async function nextCode() {
  const prefix = settings.load('production').batch_prefix || 'B';
  const day = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const n = (await get('SELECT COUNT(*) AS n FROM production_batches WHERE code LIKE ?', `${prefix}${day}-%`)).n + 1;
  return `${prefix}${day}-${String(n).padStart(3, '0')}`;
}

const event = (batchId, message, author = '') => run('INSERT INTO production_batch_events (batch_id, message, author) VALUES (?, ?, ?)', batchId, message, author);

// What a batch needs: [{ material_id, qty_base }], the expected cost and the labour minutes.
async function requirements({ formula, variant, qty }) {
  if (formula) {
    const r = await formulas.resolve(formula);
    if (r.problems.length) throw err(r.problems.join(' '), 422);
    const factor = Number(qty) / Number(formula.yield_qty);
    return {
      inputs: r.lines.map((l) => ({ material_id: l.material_id, qty_base: l.base_qty * factor, unit_cost: costing.costPerBase(l) })),
      labour: Number(formula.labour_minutes) * factor,
      estimated: Math.round(r.cost.total * factor),
    };
  }
  const c = await costing.costVariant(variant.id);
  if (!c.lines.length) throw err('This product has no recipe yet. Add its materials under Costing first.', 422);
  if (c.result.problems.length) throw err(c.result.problems.join(' '), 422);
  return {
    inputs: c.lines.map((l) => ({ material_id: l.material_id, qty_base: Number(l.quantity) * inventory.UNITS[l.unit].factor * Number(qty), unit_cost: costing.costPerBase(l.material) })),
    labour: Number(c.opts.labour_minutes) * Number(qty),
    estimated: Math.round(c.result.total * Number(qty)),
  };
}

async function createBatch({ formula_id, variant_id, planned_qty, source = 'manual', source_ref = '', planned_for = null, notes = '', staff }) {
  return tx(async () => {
    const formula = formula_id ? await get('SELECT * FROM formulas WHERE id = ?', formula_id) : null;
    const variant = variant_id ? await get('SELECT v.*, p.title AS product_title FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', variant_id) : null;
    if (!formula && !variant) throw err('Choose a formula or a product to make.', 422);
    if (formula && formula.status !== 'approved') throw err('Only approved formulas can go into production. Ask a reviewer to approve it first.', 422);
    if (!(Number(planned_qty) > 0)) throw err('Enter how much to make.', 422);
    const req = await requirements({ formula, variant, qty: planned_qty });
    const shelf = formula && formula.shelf_life_days ? new Date(Date.now() + formula.shelf_life_days * 86400000).toISOString().slice(0, 10) : null;
    const id = await insert(`INSERT INTO production_batches (code, formula_id, formula_version, variant_id, output_material_id, source, source_ref, planned_qty, output_unit,
        labour_minutes, estimated_cost, best_before, storage, notes, made_by, planned_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, await nextCode(), formula ? formula.id : null, formula ? formula.version : null,
    variant ? variant.id : null, formula ? formula.output_material_id : null, source, source_ref, planned_qty, formula ? formula.yield_unit : 'each',
    req.labour, req.estimated, shelf, formula ? formula.storage : '', notes, staff, planned_for);
    for (const i of req.inputs) await run('INSERT INTO production_batch_inputs (batch_id, material_id, planned_qty) VALUES (?, ?, ?)', id, i.material_id, i.qty_base);
    const checks = String(settings.load('production').qc_checklist || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const [i, label] of checks.entries()) await run('INSERT INTO production_quality_checks (batch_id, label, position) VALUES (?, ?, ?)', id, label, i);
    await event(id, `Batch planned: ${planned_qty} ${formula ? formula.yield_unit : 'unit(s)'} of ${formula ? formula.name : variant.product_title}.`, staff);
    return id;
  });
}

async function load(id) {
  const b = await get(`SELECT b.*, f.name AS formula_name, f.yield_unit, p.title AS product_title, v.title AS variant_title, p.id AS product_id, om.name AS output_name
    FROM production_batches b LEFT JOIN formulas f ON f.id = b.formula_id LEFT JOIN variants v ON v.id = b.variant_id LEFT JOIN products p ON p.id = v.product_id
    LEFT JOIN materials om ON om.id = b.output_material_id WHERE b.id = ?`, id);
  if (!b) return null;
  b.name = b.formula_name || `${b.product_title}${b.variant_title && b.variant_title !== 'Default Title' ? ` — ${b.variant_title}` : ''}`;
  b.inputs = await all(`SELECT i.*, m.name, m.pack_unit, m.stock_unit, m.kind, l.lot_code, l.supplier_lot, l.expires_at AS lot_expires
    FROM production_batch_inputs i JOIN materials m ON m.id = i.material_id LEFT JOIN material_lots l ON l.id = i.lot_id WHERE i.batch_id = ? ORDER BY i.id`, id);
  b.checks = await all('SELECT * FROM production_quality_checks WHERE batch_id = ? ORDER BY position, id', id);
  b.events = await all('SELECT * FROM production_batch_events WHERE batch_id = ? ORDER BY id DESC', id);
  b.outputs = await all('SELECT * FROM material_lots WHERE production_batch_id = ? ORDER BY id', id);
  b.finished = await all('SELECT * FROM finished_goods_lots WHERE batch_id = ? ORDER BY id', id);
  return b;
}

async function setStatus(id, from, to, message, staff, extra = '') {
  const b = await get('SELECT status FROM production_batches WHERE id = ?', id);
  if (!b || !from.includes(b.status)) throw err(`This batch is ${b ? b.status.replace('_', ' ') : 'missing'}, so it can't move to ${to.replace('_', ' ')}.`);
  await run(`UPDATE production_batches SET status = ?${extra} WHERE id = ?`, to, id);
  await event(id, message, staff);
}

const start = (id, staff) => setStatus(id, ['planned'], 'in_progress', 'Production started.', staff, ', started_at = now()');
const submitForQc = (id, staff) => setStatus(id, ['in_progress', 'planned'], 'awaiting_qc', 'Submitted for quality review.', staff);
const cancel = (id, staff, reason) => setStatus(id, ['planned', 'in_progress', 'awaiting_qc'], 'cancelled', `Cancelled${reason ? `: ${reason}` : ''}. No stock was used.`, staff);
const archive = (id, staff) => setStatus(id, ['released'], 'archived', 'Archived.', staff);

async function recordChecks(id, results, staff) {
  for (const [checkId, r] of Object.entries(results)) {
    if (!['pass', 'fail', 'na', 'pending'].includes(r.result)) continue;
    await run(`UPDATE production_quality_checks SET result = ?, notes = ?, checked_by = ?, checked_at = ${r.result === 'pending' ? 'NULL' : 'now()'}
      WHERE id = ? AND batch_id = ?`, r.result, String(r.notes || '').slice(0, 1000), r.result === 'pending' ? '' : staff, Number(checkId), id);
  }
  await event(id, 'Quality checks updated.', staff);
}

/**
 * Completes a batch: every quality check must pass (or be N/A). Consumes each input — from the
 * chosen lot or first-expiring/oldest — records the movements, computes the actual cost and creates
 * the output in quarantine. All in one transaction: any shortage rolls everything back.
 * used: { [inputId]: { qty_base, lot_id } }  actual: { qty, waste, labour_minutes, best_before }
 */
async function complete(id, { used = {}, actual }, staff) {
  return tx(async () => {
    const b = await load(id);
    if (!b || !['in_progress', 'awaiting_qc'].includes(b.status)) throw err('Only batches in progress or awaiting review can be completed.');
    const open = b.checks.filter((c) => !['pass', 'na'].includes(c.result));
    if (open.length) throw err(`Quality checks not passed: ${open.map((c) => c.label).join('; ')}.`, 422);
    const qty = Number(actual.qty);
    if (!(qty > 0)) throw err('Enter the actual yield.', 422);
    if (b.variant_id && !Number.isInteger(qty)) throw err('Finished products are counted in whole units.', 422);
    let materialsCost = 0;
    for (const input of b.inputs) {
      const u = used[input.id] || {};
      const q = u.qty_base !== undefined && u.qty_base !== '' ? Number(u.qty_base) : Number(input.planned_qty);
      if (!(q >= 0)) throw err(`Enter the amount of ${input.name} used.`, 422);
      if (q === 0) { await run('UPDATE production_batch_inputs SET used_qty = 0, cost = 0 WHERE id = ?', input.id); continue; }
      const taken = await inventory.consume(input.material_id, q, { lotId: u.lot_id ? Number(u.lot_id) : null, batchId: id, reason: `Batch ${b.code}`, staff });
      // One input row per lot used, so traceability is exact.
      for (const [i, t] of taken.entries()) {
        const cost = Math.round(t.qty * t.unit_cost);
        materialsCost += t.qty * t.unit_cost;
        if (i === 0) await run('UPDATE production_batch_inputs SET lot_id = ?, used_qty = ?, unit_cost = ?, cost = ? WHERE id = ?', t.lot_id, t.qty, t.unit_cost, cost, input.id);
        else await run('INSERT INTO production_batch_inputs (batch_id, material_id, lot_id, planned_qty, used_qty, unit_cost, cost) VALUES (?, ?, ?, 0, ?, ?, ?)', id, input.material_id, t.lot_id, t.qty, t.unit_cost, cost);
      }
    }
    const rates = costing.storeRates();
    const labourMin = actual.labour_minutes !== undefined && actual.labour_minutes !== '' ? Number(actual.labour_minutes) : Number(b.labour_minutes);
    const labour = (labourMin / 60) * rates.labour_rate;
    const overhead = (materialsCost + labour) * (rates.overhead_percent / 100);
    const total = Math.round(materialsCost + labour + overhead);
    const bestBefore = actual.best_before || b.best_before || null;
    let outputMaterial = b.output_material_id;
    if (b.formula_id) {
      if (!outputMaterial) {
        outputMaterial = await formulas.createOutputMaterial(b.formula_id);
        await run('UPDATE production_batches SET output_material_id = ? WHERE id = ?', outputMaterial, id);
      }
      const qtyBase = qty * inventory.UNITS[b.output_unit].factor;
      await inventory.receiveLot({
        material_id: outputMaterial, qty_base: qtyBase, unit_cost: total / qtyBase, lot_code: b.code, batch_id: id, kind: 'production_output',
        expires_at: bestBefore, status: 'quarantine', staff, reason: `Batch ${b.code}`,
      });
    } else {
      await insert('INSERT INTO finished_goods_lots (batch_id, variant_id, qty_made, qty_remaining, unit_cost, best_before, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, b.variant_id, qty, qty, total / qty, bestBefore, 'quarantine');
    }
    await run(`UPDATE production_batches SET status = 'completed', actual_qty = ?, waste_qty = ?, labour_minutes = ?, actual_cost = ?, best_before = ?,
      completed_at = now(), completed_by = ? WHERE id = ?`, qty, actual.waste === '' || actual.waste === undefined ? null : Number(actual.waste), labourMin, total, bestBefore, staff, id);
    await require('./comms').notifyStaff({ kind: 'batch', title: `Batch ${b.code} completed — awaiting release`, link: `/admin/production/${id}`, permission: 'production.approve', dedupe: `batch-complete-${id}` });
    await event(id, `Completed: ${qty} ${b.variant_id ? 'unit(s)' : b.output_unit} made at an actual cost of ${(total / 100).toFixed(2)} (estimated ${((b.estimated_cost || 0) / 100).toFixed(2)}). Output is in quarantine until released.`, staff);
    return total;
  });
}

// Releases quarantined output: component lots become usable; finished products become sellable stock.
async function release(id, staff) {
  return tx(async () => {
    const b = await load(id);
    if (!b || b.status !== 'completed') throw err('Only completed batches can be released.');
    await run("UPDATE material_lots SET status = 'available' WHERE production_batch_id = ? AND status = 'quarantine'", id);
    for (const fg of b.finished) {
      await run("UPDATE finished_goods_lots SET status = 'available' WHERE id = ?", fg.id);
      await run('UPDATE variants SET inventory_qty = inventory_qty + ? WHERE id = ? AND track_inventory = 1', fg.qty_remaining, fg.variant_id);
    }
    await run("UPDATE production_batches SET status = 'released', released_at = now(), released_by = ? WHERE id = ?", staff, id);
    await event(id, 'Released for use and sale.', staff);
  });
}

/* ---------- Sales draw from finished lots ---------- */

/** Called inside order creation: allocates sold units to released lots, oldest first. Returns the unit cost. */
async function allocateSale(orderItemId, variantId, qty, fallbackCost) {
  const lots = await all("SELECT * FROM finished_goods_lots WHERE variant_id = ? AND status = 'available' AND qty_remaining > 0 ORDER BY best_before NULLS LAST, id FOR UPDATE", variantId);
  let need = qty;
  let cost = 0;
  for (const lot of lots) {
    if (need <= 0) break;
    const q = Math.min(need, lot.qty_remaining);
    await run(`UPDATE finished_goods_lots SET qty_remaining = qty_remaining - ?, status = CASE WHEN qty_remaining - ? = 0 THEN 'depleted' ELSE status END WHERE id = ?`, q, q, lot.id);
    await run('INSERT INTO order_item_lots (order_item_id, finished_lot_id, qty, unit_cost) VALUES (?, ?, ?, ?)', orderItemId, lot.id, q, lot.unit_cost);
    cost += q * Number(lot.unit_cost);
    need -= q;
  }
  if (need > 0) cost += need * (fallbackCost ?? 0);
  if (need === qty) return fallbackCost ?? null;
  return Math.round(cost / qty);
}

/** Restocking a cancelled/refunded order line puts units back into the lots they came from. */
async function returnSale(orderItemId) {
  for (const a of await all('SELECT * FROM order_item_lots WHERE order_item_id = ? AND returned = 0', orderItemId)) {
    await run(`UPDATE finished_goods_lots SET qty_remaining = qty_remaining + ?, status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END WHERE id = ?`, a.qty, a.finished_lot_id);
    await run('UPDATE order_item_lots SET returned = 1 WHERE id = ?', a.id);
  }
}

/* ---------- Traceability ---------- */

// Everything downstream of a raw material lot: batches, component lots, finished lots, orders.
async function traceForward(lotId, seen = new Set()) {
  if (seen.has(lotId)) return { batches: [], finished: [], componentLots: [], orders: [] };
  seen.add(lotId);
  const batches = await all(`SELECT DISTINCT b.id, b.code, b.status, COALESCE(f.name, p.title) AS name FROM production_batch_inputs i JOIN production_batches b ON b.id = i.batch_id
    LEFT JOIN formulas f ON f.id = b.formula_id LEFT JOIN variants v ON v.id = b.variant_id LEFT JOIN products p ON p.id = v.product_id WHERE i.lot_id = ? ORDER BY b.id`, lotId);
  const out = { batches: [...batches], finished: [], componentLots: [], orders: [] };
  for (const b of batches) {
    const comps = await all('SELECT l.*, m.name FROM material_lots l JOIN materials m ON m.id = l.material_id WHERE l.production_batch_id = ?', b.id);
    out.componentLots.push(...comps);
    for (const c of comps) {
      const down = await traceForward(c.id, seen);
      for (const k of Object.keys(out)) out[k].push(...down[k]);
    }
    const fg = await all(`SELECT fg.*, p.title AS product_title, v.title AS variant_title, b.code FROM finished_goods_lots fg JOIN variants v ON v.id = fg.variant_id
      JOIN products p ON p.id = v.product_id JOIN production_batches b ON b.id = fg.batch_id WHERE fg.batch_id = ?`, b.id);
    out.finished.push(...fg);
  }
  const fgIds = out.finished.map((f) => f.id);
  if (fgIds.length) {
    out.orders = await all(`SELECT DISTINCT o.id, o.number, o.email, o.created_at, o.customer_id, oi.title, a.qty, fg.batch_id, b.code
      FROM order_item_lots a JOIN order_items oi ON oi.id = a.order_item_id JOIN orders o ON o.id = oi.order_id
      JOIN finished_goods_lots fg ON fg.id = a.finished_lot_id JOIN production_batches b ON b.id = fg.batch_id
      WHERE a.finished_lot_id = ANY(?::int[]) AND a.returned = 0 ORDER BY o.created_at DESC`, `{${fgIds.join(',')}}`);
  }
  out.batches = [...new Map(out.batches.map((x) => [x.id, x])).values()];
  return out;
}

// Everything upstream of a batch: the lots it used (and, for components, what they were made from).
async function traceBack(batchId, depth = 0) {
  const inputs = await all(`SELECT i.*, m.name, m.pack_unit, m.stock_unit, l.lot_code, l.supplier_lot, l.expires_at, l.production_batch_id AS made_in, s.name AS supplier
    FROM production_batch_inputs i JOIN materials m ON m.id = i.material_id LEFT JOIN material_lots l ON l.id = i.lot_id LEFT JOIN suppliers s ON s.id = l.supplier_id
    WHERE i.batch_id = ? AND i.used_qty > 0 ORDER BY m.name`, batchId);
  for (const i of inputs) if (i.made_in && depth < 5) i.sub = await traceBack(i.made_in, depth + 1);
  return inputs;
}

// Batches whose finished goods went into an order, for the order page.
async function batchesForOrder(orderId) {
  return all(`SELECT oi.id AS order_item_id, b.id, b.code, a.qty FROM order_item_lots a JOIN order_items oi ON oi.id = a.order_item_id
    JOIN finished_goods_lots fg ON fg.id = a.finished_lot_id JOIN production_batches b ON b.id = fg.batch_id WHERE oi.order_id = ? ORDER BY b.code`, orderId);
}

/** Recall: marks a lot and everything made from it as recalled and pulls unsold finished stock. */
async function recall(lotId, reason, staff) {
  return tx(async () => {
    const lot = await get('SELECT * FROM material_lots WHERE id = ?', lotId);
    if (!lot) throw err('Lot not found.', 404);
    const t = await traceForward(lotId);
    const lotIds = [lotId, ...t.componentLots.map((c) => c.id)];
    for (const id of lotIds) {
      const l = await get('SELECT * FROM material_lots WHERE id = ?', id);
      if (l.status === 'recalled') continue;
      await run("UPDATE material_lots SET status = 'recalled' WHERE id = ?", id);
      if (Number(l.qty_remaining) > 0) await inventory.recordTx({ material_id: l.material_id, lot_id: id, kind: 'recall', qty: 0, value: 0, reason: `Recalled: ${reason}`, staff });
    }
    for (const fg of t.finished) {
      if (fg.status === 'recalled') continue;
      if (fg.status === 'available') await run('UPDATE variants SET inventory_qty = GREATEST(0, inventory_qty - ?) WHERE id = ? AND track_inventory = 1', fg.qty_remaining, fg.variant_id);
      await run("UPDATE finished_goods_lots SET status = 'recalled' WHERE id = ?", fg.id);
    }
    for (const b of t.batches) await event(b.id, `Recall: lot ${lot.lot_code} — ${reason}`, staff);
    return t;
  });
}

module.exports = { STATUSES, SOURCES, requirements, createBatch, load, start, submitForQc, cancel, archive, recordChecks, complete, release, allocateSale, returnSale, traceForward, traceBack, batchesForOrder, recall };
