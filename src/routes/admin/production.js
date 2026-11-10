'use strict';
// Apothecary → Production: batches, quality review, completion with actual costs, release,
// printable batch records and labels, and lot traceability / recall.
const express = require('express');
const { get, all } = require('../../db');
const production = require('../../production');
const inventory = require('../../inventory');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, asList } = require('../../utils');

const router = express.Router();
const { UNITS } = inventory;
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');

router.use((req, res, next) => {
  Object.assign(res.locals, { UNITS, STATUSES: production.STATUSES, SOURCES: production.SOURCES, fmtQty: inventory.fmtQty, stockUnit: inventory.stockUnit, ymd, canApproveBatches: res.locals.can('production.approve') });
  next();
});

const fail = (req, res, msg, to) => { flash(req, 'error', msg); return res.redirect(to); };
const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? '' : Number(String(v).replace(/,/g, '')));

// Runs an action and turns expected errors (status set) into a message.
const act = (fn) => async (req, res) => {
  const back = req.params.id ? `/admin/production/${toInt(req.params.id)}` : '/admin/production';
  try {
    const message = await fn(req, res);
    if (message) flash(req, 'success', message);
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
  }
  if (!res.headersSent) res.redirect(back);
};

function approver(req, res, next) {
  if (res.locals.can('production.approve')) return next();
  return fail(req, res, 'Completing, releasing and recalling batches needs production approval permission.', `/admin/production/${toInt(req.params.id) || ''}`);
}

router.get('/', async (req, res) => {
  const status = production.STATUSES.some(([k]) => k === req.query.status) ? req.query.status : '';
  const batches = await all(`SELECT b.*, COALESCE(f.name, p.title) AS name, v.title AS variant_title
    FROM production_batches b LEFT JOIN formulas f ON f.id = b.formula_id LEFT JOIN variants v ON v.id = b.variant_id LEFT JOIN products p ON p.id = v.product_id
    WHERE ${status ? 'b.status = ?' : "b.status NOT IN ('archived', 'cancelled')"} ORDER BY b.id DESC LIMIT 200`, ...(status ? [status] : []));
  const counts = Object.fromEntries((await all('SELECT status, COUNT(*) AS n FROM production_batches GROUP BY status')).map((r) => [r.status, r.n]));
  res.render('admin/production/index', { title: 'Production', batches, status, counts });
});

router.get('/new', async (req, res) => {
  const [formulaList, variants] = await Promise.all([
    all("SELECT id, name, yield_qty, yield_unit FROM formulas WHERE status = 'approved' ORDER BY lower(name)"),
    all(`SELECT v.id, v.title, p.title AS product_title, (SELECT COUNT(*) FROM variant_materials vm WHERE vm.variant_id = v.id) AS lines
      FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status != 'archived' AND EXISTS (SELECT 1 FROM variant_materials vm WHERE vm.variant_id = v.id) ORDER BY lower(p.title), v.position`),
  ]);
  res.render('admin/production/new', { title: 'Plan a batch', formulaList, variants, pre: { formula: toInt(req.query.formula), variant: toInt(req.query.variant), source: req.query.source || 'manual', ref: req.query.ref || '' } });
});

router.post('/new', async (req, res) => {
  const [type, id] = String(req.body.make || '').split(':');
  try {
    const batchId = await production.createBatch({
      formula_id: type === 'formula' ? toInt(id) : null, variant_id: type === 'variant' ? toInt(id) : null, planned_qty: Number(req.body.planned_qty),
      source: production.SOURCES.some(([k]) => k === req.body.source) ? req.body.source : 'manual', source_ref: String(req.body.source_ref || '').slice(0, 200),
      planned_for: /^\d{4}-\d{2}-\d{2}$/.test(req.body.planned_for || '') ? req.body.planned_for : null, notes: String(req.body.notes || '').slice(0, 5000), staff: res.locals.staff.name,
    });
    await audit.record(req, 'batch.planned', { entityType: 'batch', entityId: batchId });
    flash(req, 'success', 'Batch planned. Check stock and lots, then start production.');
    res.redirect(`/admin/production/${batchId}`);
  } catch (e) {
    if (!e.status) throw e;
    fail(req, res, e.message, '/admin/production/new');
  }
});

/* ---------- Traceability ---------- */

router.get('/trace', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let lot = null;
  let batch = null;
  let matches = [];
  if (req.query.lot) lot = await get('SELECT l.*, m.name, m.pack_unit, m.stock_unit, s.name AS supplier FROM material_lots l JOIN materials m ON m.id = l.material_id LEFT JOIN suppliers s ON s.id = l.supplier_id WHERE l.id = ?', toInt(req.query.lot));
  if (req.query.batch) batch = await production.load(toInt(req.query.batch));
  if (q && !lot && !batch) {
    const b = await get('SELECT id FROM production_batches WHERE code ILIKE ?', q);
    if (b) return res.redirect(`/admin/production/trace?batch=${b.id}`);
    matches = await all(`SELECT l.id, l.lot_code, l.supplier_lot, m.name FROM material_lots l JOIN materials m ON m.id = l.material_id
      WHERE l.lot_code ILIKE ? OR l.supplier_lot ILIKE ? ORDER BY l.received_at DESC LIMIT 20`, `%${q}%`, `%${q}%`);
    if (matches.length === 1) return res.redirect(`/admin/production/trace?lot=${matches[0].id}`);
  }
  const forward = lot ? await production.traceForward(lot.id) : batch ? null : null;
  let batchForward = null;
  let back = null;
  if (batch) {
    back = await production.traceBack(batch.id);
    const outputs = [...batch.outputs.map((o) => o.id)];
    batchForward = { finished: batch.finished, orders: [] };
    if (batch.finished.length) {
      batchForward.orders = await all(`SELECT DISTINCT o.id, o.number, o.email, o.created_at, oi.title, a.qty FROM order_item_lots a JOIN order_items oi ON oi.id = a.order_item_id
        JOIN orders o ON o.id = oi.order_id WHERE a.finished_lot_id = ANY(?::int[]) AND a.returned = 0 ORDER BY o.created_at DESC`, `{${batch.finished.map((f) => f.id).join(',')}}`);
    }
    for (const id of outputs) {
      const t = await production.traceForward(id);
      batchForward.finished.push(...t.finished);
      batchForward.orders.push(...t.orders);
      batchForward.batches = (batchForward.batches || []).concat(t.batches);
    }
  }
  res.render('admin/production/trace', { title: 'Batch tracing', q, lot, forward, batch, back, batchForward, matches });
});

router.post('/trace/lot/:lotId/recall', approver, async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const back = `/admin/production/trace?lot=${toInt(req.params.lotId)}`;
  if (!reason) return fail(req, res, 'Give the reason for the recall.', back);
  if (req.body.confirm !== '1') return fail(req, res, 'Tick the confirmation to recall this lot and everything made from it.', back);
  const t = await production.recall(toInt(req.params.lotId), reason, res.locals.staff.name);
  await audit.record(req, 'lot.recalled', { entityType: 'lot', entityId: toInt(req.params.lotId), details: { reason, batches: t.batches.length, orders: t.orders.length } });
  flash(req, 'success', `Recalled. ${t.batches.length} batch(es), ${t.finished.length} finished lot(s) and ${t.orders.length} order(s) are affected — contact those customers.`);
  res.redirect(back);
});

/* ---------- Batch ---------- */

async function batchParam(req, res, next) {
  const b = await production.load(toInt(req.params.id));
  if (!b) return res.status(404).render('admin/error', { title: 'Not found', message: 'This batch does not exist.' });
  req.batch = b;
  next();
}

router.get('/:id', batchParam, async (req, res) => {
  const b = req.batch;
  for (const i of b.inputs) {
    i.lots = await inventory.availableLots(i.material_id);
    i.available = i.lots.reduce((s, l) => s + Number(l.qty_remaining), 0);
  }
  res.render('admin/production/show', { title: `Batch ${b.code}`, b });
});

router.get('/:id/record', batchParam, async (req, res) => res.render('admin/production/record', { title: `Batch record ${req.batch.code}`, b: req.batch, back: await production.traceBack(req.batch.id) }));

router.get('/:id/labels', batchParam, async (req, res) => {
  const b = req.batch;
  const count = Math.max(1, Math.min(200, toInt(req.query.count, b.actual_qty ? Math.min(60, Math.round(Number(b.actual_qty))) : 12)));
  const product = b.variant_id ? await get('SELECT p.title, p.ingredients, p.directions, p.warnings FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', b.variant_id) : null;
  const formula = b.formula_id ? await get('SELECT name, storage FROM formulas WHERE id = ?', b.formula_id) : null;
  const ingredients = product && product.ingredients ? product.ingredients : b.inputs.filter((i) => i.kind !== 'container' && i.kind !== 'closure' && i.kind !== 'label' && i.kind !== 'packaging').map((i) => i.name).filter((v, n, a) => a.indexOf(v) === n).join(', ');
  res.render('admin/production/labels', { title: `Labels ${b.code}`, b, count, product, formula, ingredients });
});

router.post('/:id/start', batchParam, act(async (req, res) => { await production.start(req.batch.id, res.locals.staff.name); return 'Production started.'; }));
router.post('/:id/qc', batchParam, act(async (req, res) => { await production.submitForQc(req.batch.id, res.locals.staff.name); return 'Sent for quality review.'; }));
router.post('/:id/checks', batchParam, act(async (req, res) => {
  const results = {};
  for (const [id, r] of Object.entries(req.body.checks || {})) results[String(id).replace(/^id/, '')] = r;
  await production.recordChecks(req.batch.id, results, res.locals.staff.name);
  return 'Quality checks saved.';
}));
router.post('/:id/cancel', batchParam, act(async (req, res) => { await production.cancel(req.batch.id, res.locals.staff.name, String(req.body.reason || '').slice(0, 300)); return 'Batch cancelled.'; }));
router.post('/:id/archive', batchParam, act(async (req, res) => { await production.archive(req.batch.id, res.locals.staff.name); return 'Batch archived.'; }));

router.post('/:id/complete', approver, batchParam, act(async (req, res) => {
  const used = {};
  for (const [key, u] of Object.entries(req.body.used || {})) {
    const input = req.batch.inputs.find((i) => i.id === toInt(String(key).replace(/^id/, '')));
    if (!input) continue;
    const unit = inventory.stockUnit(input);
    const q = num(u.qty);
    used[input.id] = { qty_base: q === '' ? '' : inventory.base(q, unit), lot_id: toInt(u.lot_id) || null };
  }
  const total = await production.complete(req.batch.id, {
    used, actual: { qty: Number(req.body.actual_qty), waste: num(req.body.waste_qty), labour_minutes: num(req.body.labour_minutes), best_before: /^\d{4}-\d{2}-\d{2}$/.test(req.body.best_before || '') ? req.body.best_before : null },
  }, res.locals.staff.name);
  await audit.record(req, 'batch.completed', { entityType: 'batch', entityId: req.batch.id, details: { actual_cost: total } });
  return `Batch completed. Actual cost ${res.locals.money(total)}. Release it once you're happy with it.`;
}));

router.post('/:id/release', approver, batchParam, act(async (req, res) => {
  await production.release(req.batch.id, res.locals.staff.name);
  await audit.record(req, 'batch.released', { entityType: 'batch', entityId: req.batch.id });
  return 'Batch released.';
}));

module.exports = router;
