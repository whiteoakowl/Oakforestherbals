'use strict';
// Product costing: unit conversion, per-variant cost roll-up from a bill of materials, and
// recalculation when a material's price changes. Money is integer cents; intermediate maths is
// done in floating point and rounded once, at the end, to the nearest cent.
const { get, all, run, tx } = require('./db');
const settings = require('./settings');

// Base units: grams (mass), millilitres (volume), each (count).
const UNITS = {
  g: { type: 'mass', factor: 1, label: 'g' },
  kg: { type: 'mass', factor: 1000, label: 'kg' },
  oz: { type: 'mass', factor: 28.349523125, label: 'oz' },
  lb: { type: 'mass', factor: 453.59237, label: 'lb' },
  ml: { type: 'volume', factor: 1, label: 'ml' },
  l: { type: 'volume', factor: 1000, label: 'L' },
  fl_oz: { type: 'volume', factor: 29.5735295625, label: 'fl oz' },
  each: { type: 'count', factor: 1, label: 'each' },
};

const KINDS = [
  ['herb', 'Herb'], ['ingredient', 'Other ingredient'], ['container', 'Bottle / jar'], ['closure', 'Cap / dropper'],
  ['label', 'Label'], ['packaging', 'Packaging'], ['shipping', 'Shipping material'], ['other', 'Other'],
];

const isUnit = (u) => Object.hasOwn(UNITS, u);

// Converts qty from one unit to another of the same type; null when the types differ.
function convert(qty, from, to) {
  if (!isUnit(from) || !isUnit(to) || UNITS[from].type !== UNITS[to].type) return null;
  return (Number(qty) * UNITS[from].factor) / UNITS[to].factor;
}

// Cents per base unit (per gram, per ml or per each) of a material.
function costPerBase(material) {
  const base = Number(material.pack_size) * UNITS[material.pack_unit].factor;
  return base > 0 ? Number(material.pack_cost) / base : 0;
}

const pct = (v) => Math.max(0, Number(v) || 0) / 100;

/**
 * Pure cost calculation for one unit of a variant.
 * lines: [{ quantity, unit, material: { name, pack_size, pack_unit, pack_cost } }]
 * opts: { labour_minutes, waste_percent, overhead_percent, extra_cost } (already resolved to numbers)
 * rates: { labour_rate } in cents per hour
 */
function calculate(lines, opts, rates) {
  const problems = [];
  const items = lines.map((line) => {
    const m = line.material;
    const base = convert(line.quantity, line.unit, m.pack_unit);
    if (base === null) {
      problems.push(`${m.name}: ${UNITS[line.unit] ? UNITS[line.unit].label : line.unit} can't be converted to ${UNITS[m.pack_unit].label}.`);
      return { ...line, cost: 0, error: true };
    }
    const cost = (base / Number(m.pack_size)) * Number(m.pack_cost);
    return { ...line, cost };
  });
  const materials = items.reduce((s, i) => s + i.cost, 0);
  const waste = materials * pct(opts.waste_percent);
  const labour = (Math.max(0, Number(opts.labour_minutes) || 0) / 60) * (Number(rates.labour_rate) || 0);
  const extra = Math.max(0, Number(opts.extra_cost) || 0);
  const beforeOverhead = materials + waste + labour + extra;
  const overhead = beforeOverhead * pct(opts.overhead_percent);
  const total = Math.round(beforeOverhead + overhead);
  return {
    items: items.map((i) => ({ ...i, cost: Math.round(i.cost * 100) / 100 })),
    materials: Math.round(materials), waste: Math.round(waste), labour: Math.round(labour), extra: Math.round(extra),
    overhead: Math.round(overhead), total, problems,
  };
}

// Gross profit and margin for a price, given a unit cost. null when there is no price.
function margin(price, cost) {
  if (!price || cost === null || cost === undefined) return null;
  return { profit: price - cost, percent: Math.round(((price - cost) / price) * 1000) / 10 };
}

function storeRates() {
  const c = settings.load('costing');
  return { labour_rate: Number(c.labour_rate) || 0, waste_percent: Number(c.default_waste_percent) || 0, overhead_percent: Number(c.default_overhead_percent) || 0 };
}

// Everything needed to cost one variant.
async function variantInputs(variantId) {
  const lines = await all(`SELECT vm.id, vm.quantity, vm.unit, vm.position, m.id AS material_id, m.name, m.kind, m.pack_size, m.pack_unit, m.pack_cost
    FROM variant_materials vm JOIN materials m ON m.id = vm.material_id WHERE vm.variant_id = ? ORDER BY vm.position, vm.id`, variantId);
  const settingsRow = await get('SELECT * FROM variant_costing WHERE variant_id = ?', variantId);
  return {
    lines: lines.map((l) => ({ id: l.id, quantity: Number(l.quantity), unit: l.unit, material_id: l.material_id,
      material: { name: l.name, kind: l.kind, pack_size: Number(l.pack_size), pack_unit: l.pack_unit, pack_cost: Number(l.pack_cost) } })),
    costing: settingsRow || null,
  };
}

function resolveOpts(costing, rates) {
  return {
    labour_minutes: costing ? Number(costing.labour_minutes) : 0,
    waste_percent: costing && costing.waste_percent !== null ? Number(costing.waste_percent) : rates.waste_percent,
    overhead_percent: costing && costing.overhead_percent !== null ? Number(costing.overhead_percent) : rates.overhead_percent,
    extra_cost: costing ? Number(costing.extra_cost) : 0,
  };
}

async function costVariant(variantId) {
  const rates = storeRates();
  const { lines, costing } = await variantInputs(variantId);
  const opts = resolveOpts(costing, rates);
  return { lines, costing, opts, rates, result: calculate(lines, opts, rates) };
}

/**
 * Recalculates a variant and, when it has a bill of materials and uses the calculated cost,
 * writes the result to variants.cost (which the existing margin display and reports read).
 * Returns { before, after } in cents.
 */
async function recalcVariant(variantId) {
  const { lines, costing, result } = await costVariant(variantId);
  const variant = await get('SELECT cost FROM variants WHERE id = ?', variantId);
  if (!variant) return null;
  const before = variant.cost;
  const hasBom = lines.length > 0 || (costing && (Number(costing.labour_minutes) > 0 || Number(costing.extra_cost) > 0));
  if (!hasBom) return { before, after: before, applied: false };
  await run(`INSERT INTO variant_costing (variant_id, calculated_cost, calculated_at) VALUES (?, ?, now())
    ON CONFLICT (variant_id) DO UPDATE SET calculated_cost = EXCLUDED.calculated_cost, calculated_at = now()`, variantId, result.total);
  const use = !costing || costing.use_calculated;
  if (use && !result.problems.length) await run('UPDATE variants SET cost = ? WHERE id = ?', result.total, variantId);
  return { before, after: use && !result.problems.length ? result.total : before, applied: use && !result.problems.length, calculated: result.total };
}

// Every variant whose bill of materials uses the material.
async function variantsUsing(materialId) {
  return all(`SELECT DISTINCT v.id, v.title, v.price, v.wholesale_price, v.cost, p.id AS product_id, p.title AS product_title, p.product_type
    FROM variant_materials vm JOIN variants v ON v.id = vm.variant_id JOIN products p ON p.id = v.product_id
    WHERE vm.material_id = ? ORDER BY p.title, v.id`, materialId);
}

// After a material price change: recalculates every affected variant and reports the impact.
async function recalcForMaterial(materialId) {
  return tx(async () => {
    const impact = [];
    for (const v of await variantsUsing(materialId)) {
      const r = await recalcVariant(v.id);
      impact.push({ ...v, before: r.before, after: r.after, applied: r.applied, calculated: r.calculated });
    }
    return impact;
  });
}

async function recalcAll() {
  const rows = await all('SELECT DISTINCT variant_id FROM variant_costing UNION SELECT DISTINCT variant_id FROM variant_materials');
  return tx(async () => {
    for (const r of rows) await recalcVariant(r.variant_id);
    return rows.length;
  });
}

module.exports = { UNITS, KINDS, isUnit, convert, costPerBase, calculate, margin, storeRates, costVariant, recalcVariant, variantsUsing, recalcForMaterial, recalcAll, resolveOpts };
