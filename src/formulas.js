'use strict';
// Formulas: herbal recipes with ingredient amounts, parts or percentages; automatic weights,
// percentages, costs and scaling; links to the herbal database for safety; versions and approval.
// A formula can produce a component (a material, e.g. "Chamomile tincture 1:5 (bulk)") whose cost
// follows the formula, so product recipes that use it stay costed, like Craftybase components.
const { get, all, run, insert, tx } = require('./db');
const costing = require('./costing');

const { UNITS, convert } = costing;
const CATEGORIES = [
  ['tea', 'Tea blend'], ['tincture', 'Tincture'], ['glycerite', 'Glycerite'], ['infused_oil', 'Infused oil'], ['salve', 'Salve / balm'],
  ['syrup', 'Syrup'], ['oxymel', 'Oxymel'], ['vinegar', 'Herbal vinegar'], ['capsule', 'Capsules'], ['powder', 'Powder'], ['extract', 'Extract'], ['other', 'Other preparation'],
];
const MODES = [['amount', 'Amounts'], ['parts', 'Parts'], ['percent', 'Percentages']];

// Ingredients with their actual quantity per batch (in base units), share of the total, and cost.
async function resolve(formula) {
  const lines = await all(`SELECT fi.*, m.name, m.kind, m.pack_size, m.pack_unit, m.pack_cost, m.herb_id, m.formula_id AS component_of,
      h.common_name AS herb_name, h.slug AS herb_slug
    FROM formula_ingredients fi JOIN materials m ON m.id = fi.material_id LEFT JOIN herbs h ON h.id = m.herb_id
    WHERE fi.formula_id = ? ORDER BY fi.position, fi.id`, formula.id);
  const yieldBase = Number(formula.yield_qty) * UNITS[formula.yield_unit].factor;
  const problems = [];
  const totalParts = lines.reduce((s, l) => s + Number(l.quantity), 0);
  for (const l of lines) {
    l.quantity = Number(l.quantity);
    l.pack_size = Number(l.pack_size);
    let amount;
    let unit;
    if (formula.entry_mode === 'amount') { amount = l.quantity; unit = l.unit; } else {
      const share = formula.entry_mode === 'parts' ? l.quantity / (totalParts || 1) : l.quantity / 100;
      amount = share * Number(formula.yield_qty); unit = formula.yield_unit;
    }
    l.amount = amount;
    l.amount_unit = unit;
    const inPack = convert(amount, unit, l.pack_unit);
    l.base_qty = amount * UNITS[unit].factor;
    if (inPack === null) { problems.push(`${l.name}: ${UNITS[unit].label} can't be converted to how it's bought (${UNITS[l.pack_unit].label}).`); l.cost = 0; } else l.cost = (inPack / l.pack_size) * l.pack_cost;
  }
  if (formula.entry_mode === 'percent' && lines.length && Math.abs(totalParts - 100) > 0.01) problems.push(`Percentages add up to ${Math.round(totalParts * 100) / 100}%, not 100%.`);
  // Shares are only meaningful when every ingredient is measured the same way (all by weight, etc.).
  const types = new Set(lines.map((l) => UNITS[l.amount_unit].type));
  const total = lines.reduce((s, l) => s + l.base_qty, 0);
  for (const l of lines) l.percent = types.size === 1 && total ? Math.round((l.base_qty / total) * 1000) / 10 : null;
  for (const l of lines) l.ratio = types.size === 1 && lines.length ? Math.round((l.base_qty / Math.min(...lines.map((x) => x.base_qty))) * 100) / 100 : null;
  const materials = lines.reduce((s, l) => s + l.cost, 0);
  const rates = costing.storeRates();
  const labour = (Number(formula.labour_minutes) / 60) * rates.labour_rate;
  const waste = materials * (rates.waste_percent / 100);
  const overhead = (materials + waste + labour) * (rates.overhead_percent / 100);
  const totalCost = Math.round(materials + waste + labour + overhead);
  return {
    lines, problems, totalBase: total, totalType: types.size === 1 ? [...types][0] : null, yieldBase,
    cost: { materials: Math.round(materials), waste: Math.round(waste), labour: Math.round(labour), overhead: Math.round(overhead), total: totalCost, perBase: yieldBase ? totalCost / yieldBase : 0 },
  };
}

// Same formula for a different batch size. targetQty/targetUnit must be the same kind of unit as the yield.
function scaleFactor(formula, targetQty, targetUnit) {
  const t = convert(Number(targetQty), targetUnit, formula.yield_unit);
  return t === null ? null : t / Number(formula.yield_qty);
}

// Safety from the herbal database for every herb in the formula, plus gaps.
async function safety(formulaId) {
  const herbsIn = await all(`SELECT DISTINCT h.id, h.common_name, h.latin_name, h.slug FROM formula_ingredients fi JOIN materials m ON m.id = fi.material_id
    JOIN herbs h ON h.id = m.herb_id WHERE fi.formula_id = ?`, formulaId);
  const entries = herbsIn.length ? await all(`SELECT s.*, h.common_name, src.title AS source_title FROM herb_safety s JOIN herbs h ON h.id = s.herb_id
    JOIN herb_sources src ON src.id = s.source_id WHERE s.herb_id = ANY(?::int[]) ORDER BY h.common_name, s.kind`, `{${herbsIn.map((h) => h.id).join(',')}}`) : [];
  const unlinked = await all(`SELECT DISTINCT m.id, m.name FROM formula_ingredients fi JOIN materials m ON m.id = fi.material_id
    WHERE fi.formula_id = ? AND m.kind = 'herb' AND m.herb_id IS NULL`, formulaId);
  const noSafety = herbsIn.filter((h) => !entries.some((e) => e.herb_id === h.id));
  return { herbs: herbsIn, entries, unlinked, noSafety };
}

async function snapshot(formula) {
  const lines = await all('SELECT material_id, quantity, unit, notes, position FROM formula_ingredients WHERE formula_id = ? ORDER BY position, id', formula.id);
  const keep = ['name', 'category', 'description', 'entry_mode', 'yield_qty', 'yield_unit', 'intended_use', 'instructions', 'storage', 'shelf_life_days', 'labour_minutes', 'practitioner_notes', 'safety_notes'];
  return JSON.stringify({ ...Object.fromEntries(keep.map((k) => [k, formula[k]])), ingredients: lines });
}

async function saveVersion(formulaId, note, staffName) {
  const f = await get('SELECT * FROM formulas WHERE id = ?', formulaId);
  await run(`INSERT INTO formula_versions (formula_id, version, snapshot, note, saved_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (formula_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot, note = EXCLUDED.note, saved_by = EXCLUDED.saved_by, created_at = now()`,
  f.id, f.version, await snapshot(f), note, staffName);
}

// Keeps a formula's component material priced at the formula's current cost per yield.
async function refreshOutputPrice(formulaId, depth = 0) {
  const f = await get('SELECT * FROM formulas WHERE id = ?', formulaId);
  if (!f || !f.output_material_id) return;
  const r = await resolve(f);
  const m = await get('SELECT * FROM materials WHERE id = ?', f.output_material_id);
  if (!m) return;
  if (m.pack_cost !== r.cost.total || Number(m.pack_size) !== Number(f.yield_qty) || m.pack_unit !== f.yield_unit) {
    await run('UPDATE materials SET pack_cost = ?, pack_size = ?, pack_unit = ?, updated_at = now() WHERE id = ?', r.cost.total, f.yield_qty, f.yield_unit, m.id);
    await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)', m.id, f.yield_qty, f.yield_unit, r.cost.total, `Formula: ${f.name}`);
    await costing.recalcForMaterial(m.id, depth + 1);
  }
}

async function createOutputMaterial(formulaId) {
  return tx(async () => {
    const f = await get('SELECT * FROM formulas WHERE id = ?', formulaId);
    if (f.output_material_id) return f.output_material_id;
    const r = await resolve(f);
    const id = await insert(`INSERT INTO materials (name, kind, pack_size, pack_unit, pack_cost, notes, formula_id, stock_unit)
      VALUES (?, 'component', ?, ?, ?, ?, ?, ?)`, f.name, f.yield_qty, f.yield_unit, r.cost.total, 'Made in-house from a formula; its cost follows the formula.', f.id, f.yield_unit);
    await run('UPDATE formulas SET output_material_id = ? WHERE id = ?', id, f.id);
    await run('INSERT INTO material_price_history (material_id, pack_size, pack_unit, pack_cost, changed_by) VALUES (?, ?, ?, ?, ?)', id, f.yield_qty, f.yield_unit, r.cost.total, `Formula: ${f.name}`);
    return id;
  });
}

// Formulas (and their components) that use a material, for "what does this price change affect".
async function usingMaterial(materialId) {
  return all('SELECT DISTINCT f.id, f.name, f.output_material_id FROM formula_ingredients fi JOIN formulas f ON f.id = fi.formula_id WHERE fi.material_id = ?', materialId);
}

// Formulas visible to a staff member: shared ones, and their own private ones.
function visibleSql(staffId, alias = 'f') {
  return { sql: `(${alias}.visibility = 'shared' OR ${alias}.owner_id = ?)`, params: [staffId] };
}

module.exports = { CATEGORIES, MODES, resolve, scaleFactor, safety, snapshot, saveVersion, refreshOutputPrice, createOutputMaterial, usingMaterial, visibleSql };
