'use strict';
// Store → Costing: materials (herbs, ingredients, packaging), cost settings, and per-product
// bills of materials that roll up into each variant's cost.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const settings = require('../../settings');
const costing = require('../../costing');
const audit = require('../../audit');
const catalog = require('../../catalog');
const { flash } = require('../../middleware');
const { toInt, parseMoney, asBool, asList, paginate } = require('../../utils');

const router = express.Router();
const KIND_KEYS = costing.KINDS.map(([k]) => k);

router.use(async (req, res, next) => {
  Object.assign(res.locals, { UNITS: costing.UNITS, KINDS: costing.KINDS, costPerBase: costing.costPerBase, margin: costing.margin });
  if (req.method === 'GET' && /^\/materials\//.test(req.path)) {
    res.locals.herbOptions = await all("SELECT id, common_name, latin_name FROM herbs ORDER BY lower(common_name)");
    res.locals.supplierOptions = await all('SELECT id, name FROM suppliers WHERE archived = 0 ORDER BY lower(name)');
  }
  next();
});

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/* ---------- Materials ---------- */

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kind = KIND_KEYS.includes(req.query.kind) ? req.query.kind : '';
  const showArchived = req.query.archived === '1';
  const where = [showArchived ? 'm.archived = 1' : 'm.archived = 0'];
  const params = [];
  if (q) { where.push('(m.name ILIKE ? OR m.botanical_name ILIKE ? OR m.supplier ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (kind) { where.push('m.kind = ?'); params.push(kind); }
  const total = (await get(`SELECT COUNT(*) AS n FROM materials m WHERE ${where.join(' AND ')}`, ...params)).n;
  const pager = paginate(total, req.query.page, 50);
  const materials = await all(`SELECT m.*, (SELECT COUNT(DISTINCT variant_id) FROM variant_materials vm WHERE vm.material_id = m.id) AS used_in
    FROM materials m WHERE ${where.join(' AND ')} ORDER BY lower(m.name) LIMIT ? OFFSET ?`, ...params, pager.perPage, pager.offset);
  const costed = (await get('SELECT COUNT(DISTINCT variant_id) AS n FROM variant_materials')).n;
  res.render('admin/costing/index', { title: 'Costing', materials, pager, q, kind, showArchived, costed, s: settings.load('costing') });
});

router.post('/settings', async (req, res) => {
  const labour = parseMoney(req.body.labour_rate);
  const waste = num(req.body.default_waste_percent);
  const overhead = num(req.body.default_overhead_percent);
  if ([waste, overhead].some((v) => Number.isNaN(v) || (v !== null && (v < 0 || v > 500))) || (labour !== null && labour < 0)) {
    flash(req, 'error', 'Percentages must be between 0 and 500, and the labour rate can\'t be negative.');
    return res.redirect('/admin/costing');
  }
  await settings.save('costing', { labour_rate: labour || 0, default_waste_percent: waste || 0, default_overhead_percent: overhead || 0 });
  const n = await costing.recalcAll();
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'costing', details: { labour_rate: labour || 0, waste: waste || 0, overhead: overhead || 0 } });
  flash(req, 'success', `Cost settings saved. ${n} costed variant(s) recalculated.`);
  res.redirect('/admin/costing');
});

function readMaterial(body) {
  const m = {
    name: String(body.name || '').trim(),
    botanical_name: String(body.botanical_name || '').trim(),
    kind: KIND_KEYS.includes(body.kind) ? body.kind : 'other',
    pack_size: num(body.pack_size),
    pack_unit: String(body.pack_unit || ''),
    pack_cost: parseMoney(body.pack_cost),
    supplier: String(body.supplier || '').trim(),
    supplier_sku: String(body.supplier_sku || '').trim(),
    notes: String(body.notes || ''),
    sku: String(body.sku || '').trim(),
    herb_id: Number(body.herb_id) || null,
    plant_part: String(body.plant_part || '').trim(),
    stock_unit: costing.isUnit(body.stock_unit) ? body.stock_unit : null,
    reorder_point: num(body.reorder_point),
    storage_instructions: String(body.storage_instructions || ''),
    organic: body.organic === '1' ? 1 : 0,
    track_stock: body.track_stock === '0' ? 0 : 1,
    supplier_id: Number(body.supplier_id) || null,
  };
  const errors = [];
  if (!m.name) errors.push('Name is required.');
  if (!(m.pack_size > 0)) errors.push('Pack size must be more than zero.');
  if (!costing.isUnit(m.pack_unit)) errors.push('Choose a unit.');
  if (m.pack_cost === null || m.pack_cost < 0) errors.push('Enter the pack cost (0 or more).');
  if (m.stock_unit && costing.isUnit(m.pack_unit) && costing.UNITS[m.stock_unit].type !== costing.UNITS[m.pack_unit].type) m.stock_unit = m.pack_unit;
  // The reorder point is entered in the stock unit and stored in base units (g, ml, each).
  if (Number.isNaN(m.reorder_point)) errors.push('The reorder point must be a number.');
  else if (m.reorder_point !== null && costing.isUnit(m.pack_unit)) m.reorder_point *= costing.UNITS[m.stock_unit || m.pack_unit].factor;
  return { m, errors };
}

const EXTRA_COLS = ['sku', 'herb_id', 'plant_part', 'stock_unit', 'reorder_point', 'storage_instructions', 'organic', 'track_stock', 'supplier_id'];
async function saveExtras(id, m) {
  if (m.supplier_id) {
    const s = await get('SELECT name FROM suppliers WHERE id = ?', m.supplier_id);
    if (s) m.supplier = s.name; else m.supplier_id = null;
  }
  await run(`UPDATE materials SET ${EXTRA_COLS.map((c) => `${c} = ?`).join(', ')}, supplier = COALESCE(NULLIF(?, ''), supplier) WHERE id = ?`, ...EXTRA_COLS.map((c) => m[c]), m.supplier_id ? m.supplier : '', id);
}

router.get('/materials/new', async (req, res) => {
  res.render('admin/costing/material', { title: 'Add material', material: null, usedIn: [], history: [], impact: null });
});

router.post('/materials/new', async (req, res) => {
  const { m, errors } = readMaterial(req.body);
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect('/admin/costing/materials/new');
  }
  const id = await tx(async () => {
    const newId = await insert(`INSERT INTO materials (name, botanical_name, kind, pack_size, pack_unit, pack_cost, supplier, supplier_sku, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.name, m.botanical_name, m.kind, m.pack_size, m.pack_unit, m.pack_cost, m.supplier, m.supplier_sku, m.notes);
    await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)',
      newId, m.pack_size, m.pack_unit, m.pack_cost, res.locals.staff.name);
    await saveExtras(newId, m);
    return newId;
  });
  flash(req, 'success', 'Material added.');
  res.redirect(`/admin/costing/materials/${id}`);
});

async function loadMaterial(id) {
  const m = await get('SELECT * FROM materials WHERE id = ?', id);
  if (m) Object.assign(m, { pack_size: Number(m.pack_size) });
  return m;
}

router.get('/materials/:id', async (req, res, next) => {
  const material = await loadMaterial(toInt(req.params.id));
  if (!material) return next();
  const usedIn = await costing.variantsUsing(material.id);
  const history = (await all('SELECT * FROM material_price_history WHERE material_id = ? ORDER BY id DESC LIMIT 20', material.id))
    .map((h) => ({ ...h, pack_size: Number(h.pack_size) }));
  const impact = req.session.costImpact && req.session.costImpact.material_id === material.id ? req.session.costImpact.rows : null;
  delete req.session.costImpact;
  res.render('admin/costing/material', { title: material.name, material, usedIn, history, impact });
});

router.post('/materials/:id', async (req, res, next) => {
  const before = await loadMaterial(toInt(req.params.id));
  if (!before) return next();
  const { m, errors } = readMaterial(req.body);
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(`/admin/costing/materials/${before.id}`);
  }
  // A unit can't switch type (grams → each) while recipes measure it the old way.
  const inUse = (await get('SELECT COUNT(*) AS n FROM variant_materials WHERE material_id = ?', before.id)).n;
  if (inUse && costing.UNITS[m.pack_unit].type !== costing.UNITS[before.pack_unit].type) {
    flash(req, 'error', `This material is used in ${inUse} recipe line(s) measured by ${costing.UNITS[before.pack_unit].type}; keep a ${costing.UNITS[before.pack_unit].type} unit.`);
    return res.redirect(`/admin/costing/materials/${before.id}`);
  }
  const priceChanged = m.pack_cost !== before.pack_cost || m.pack_size !== before.pack_size || m.pack_unit !== before.pack_unit;
  let impact = [];
  await tx(async () => {
    await run(`UPDATE materials SET name = ?, botanical_name = ?, kind = ?, pack_size = ?, pack_unit = ?, pack_cost = ?, supplier = ?,
      supplier_sku = ?, notes = ?, updated_at = now() WHERE id = ?`, m.name, m.botanical_name, m.kind, m.pack_size, m.pack_unit, m.pack_cost,
    m.supplier, m.supplier_sku, m.notes, before.id);
    await saveExtras(before.id, m);
    if (priceChanged) {
      await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)',
        before.id, m.pack_size, m.pack_unit, m.pack_cost, res.locals.staff.name);
      impact = await costing.recalcForMaterial(before.id);
    }
  });
  if (priceChanged) {
    await audit.record(req, 'material.price_changed', {
      entityType: 'material', entityId: before.id,
      details: { name: m.name, from: `${before.pack_cost}/${before.pack_size}${before.pack_unit}`, to: `${m.pack_cost}/${m.pack_size}${m.pack_unit}`, variants_affected: impact.length },
    });
    req.session.costImpact = { material_id: before.id, rows: impact };
  }
  flash(req, 'success', priceChanged ? `Material saved. ${impact.length} product variant(s) recalculated — see the impact below.` : 'Material saved.');
  res.redirect(`/admin/costing/materials/${before.id}`);
});

router.post('/materials/:id/archive', async (req, res, next) => {
  const m = await loadMaterial(toInt(req.params.id));
  if (!m) return next();
  await run('UPDATE materials SET archived = ?, updated_at = now() WHERE id = ?', m.archived ? 0 : 1, m.id);
  flash(req, 'success', m.archived ? 'Material restored.' : 'Material archived. Existing recipes keep using its cost.');
  res.redirect(`/admin/costing/materials/${m.id}`);
});

router.post('/materials/:id/delete', async (req, res, next) => {
  const m = await loadMaterial(toInt(req.params.id));
  if (!m) return next();
  const inUse = (await get('SELECT COUNT(*) AS n FROM variant_materials WHERE material_id = ?', m.id)).n;
  if (inUse) {
    flash(req, 'error', `This material is used in ${inUse} recipe line(s). Remove it from those products or archive it instead.`);
    return res.redirect(`/admin/costing/materials/${m.id}`);
  }
  await run('DELETE FROM materials WHERE id = ?', m.id);
  await audit.record(req, 'material.deleted', { entityType: 'material', entityId: m.id, details: { name: m.name } });
  flash(req, 'success', 'Material deleted.');
  res.redirect('/admin/costing');
});

/* ---------- Product costing (bill of materials per variant) ---------- */

router.get('/products/:id', async (req, res, next) => {
  const product = await catalog.productById(toInt(req.params.id));
  if (!product) return next();
  const variants = [];
  for (const v of product.variants) {
    const batches = await all(`SELECT id, code, status, actual_qty, actual_cost, estimated_cost, planned_qty, completed_at FROM production_batches
      WHERE variant_id = ? AND actual_cost IS NOT NULL ORDER BY id DESC LIMIT 5`, v.id);
    const made = batches.reduce((s, b) => s + Number(b.actual_qty), 0);
    const sold = await get(`SELECT COALESCE(SUM(oi.quantity), 0) AS units, COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS cogs FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.variant_id = ? AND o.status != 'cancelled' AND oi.unit_cost IS NOT NULL AND o.created_at >= now() - interval '90 days'`, v.id);
    variants.push({
      ...v, costing: await costing.costVariant(v.id), batches,
      actualUnit: made ? Math.round(batches.reduce((s, b) => s + b.actual_cost, 0) / made) : null,
      soldUnits: Number(sold.units), soldUnit: Number(sold.units) ? Math.round(Number(sold.cogs) / Number(sold.units)) : null,
    });
  }
  const materials = await all('SELECT id, name, kind, pack_unit, archived FROM materials ORDER BY archived, lower(name)');
  res.render('admin/costing/product', { title: `Costing — ${product.title}`, product, variants, materials, rates: costing.storeRates() });
});

router.post('/products/:id/variants/:vid', async (req, res, next) => {
  const productId = toInt(req.params.id);
  const variant = await get('SELECT * FROM variants WHERE id = ? AND product_id = ?', toInt(req.params.vid), productId);
  if (!variant) return next();
  const back = `/admin/costing/products/${productId}#variant-${variant.id}`;
  const errors = [];
  const lines = [];
  for (const [i, line] of asList(req.body.lines).entries()) {
    if (!line || !line.material_id || asBool(line.remove)) continue;
    const material = await get('SELECT * FROM materials WHERE id = ?', toInt(line.material_id));
    const quantity = num(line.quantity);
    if (!material) { errors.push('One of the materials no longer exists.'); continue; }
    if (!(quantity > 0)) { errors.push(`${material.name}: enter a quantity above zero.`); continue; }
    const unit = costing.isUnit(line.unit) ? line.unit : material.pack_unit;
    if (costing.convert(1, unit, material.pack_unit) === null) {
      errors.push(`${material.name} is bought by ${costing.UNITS[material.pack_unit].type}; measure it in a ${costing.UNITS[material.pack_unit].type} unit.`);
      continue;
    }
    lines.push({ material_id: material.id, quantity, unit, position: i });
  }
  const labour = num(req.body.labour_minutes);
  const waste = num(req.body.waste_percent);
  const overhead = num(req.body.overhead_percent);
  const extra = parseMoney(req.body.extra_cost);
  const wholesale = parseMoney(req.body.wholesale_price);
  if ([labour, waste, overhead].some((v) => Number.isNaN(v) || (v !== null && v < 0))) errors.push('Labour, waste and overhead must be numbers of 0 or more.');
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(back);
  }
  let result;
  await tx(async () => {
    await run('DELETE FROM variant_materials WHERE variant_id = ?', variant.id);
    for (const l of lines) {
      await run('INSERT INTO variant_materials (variant_id, material_id, quantity, unit, position) VALUES (?, ?, ?, ?, ?)', variant.id, l.material_id, l.quantity, l.unit, l.position);
    }
    await run(`INSERT INTO variant_costing (variant_id, labour_minutes, waste_percent, overhead_percent, extra_cost, use_calculated)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (variant_id) DO UPDATE SET labour_minutes = EXCLUDED.labour_minutes,
      waste_percent = EXCLUDED.waste_percent, overhead_percent = EXCLUDED.overhead_percent, extra_cost = EXCLUDED.extra_cost,
      use_calculated = EXCLUDED.use_calculated`, variant.id, labour || 0, waste, overhead, extra || 0, asBool(req.body.use_calculated) ? 1 : 0);
    await run('UPDATE variants SET wholesale_price = ? WHERE id = ?', wholesale, variant.id);
    result = await costing.recalcVariant(variant.id);
  });
  let message;
  if (result.applied) message = `Saved. Cost per unit is now ${res.locals.money(result.after)}.`;
  else if (result.calculated === undefined) message = 'Saved. Add materials, labour or other costs to calculate a cost per unit.';
  else message = `Saved. Calculated cost ${res.locals.money(result.calculated)} was not applied: this variant keeps its manually entered cost.`;
  flash(req, 'success', message);
  res.redirect(back);
});

module.exports = router;
