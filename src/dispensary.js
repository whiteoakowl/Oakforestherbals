'use strict';
// Dispensing from the chart: make up a formula for a client in any amount. Ingredients are scaled
// from the formula, taken from stock oldest-expiry-first (with lot numbers kept for traceability),
// costed at what those lots actually cost, labelled, and optionally invoiced.
const { get, all, insert } = require('./db');
const formulas = require('./formulas');
const inventory = require('./inventory');
const vault = require('./vault');
const { token } = require('./utils');

// Ingredients for `qty unit` of a formula, with cost, or { error }.
async function preview(formulaId, staffId, qty, unit) {
  const v = formulas.visibleSql(staffId);
  const f = await get(`SELECT * FROM formulas f WHERE f.id = ? AND ${v.sql}`, formulaId, ...v.params);
  if (!f) return { error: 'Choose a formula you can see.' };
  const amount = Number(qty);
  if (!(amount > 0)) return { error: 'Enter how much to make.', formula: f };
  const factor = formulas.scaleFactor(f, amount, unit);
  if (factor === null) return { error: `${unit} can’t be converted to the formula’s unit (${f.yield_unit}).`, formula: f };
  const r = await formulas.resolve(f);
  const lines = r.lines.map((l) => ({ material_id: l.material_id, name: l.name, amount: Math.round(l.amount * factor * 1000) / 1000, unit: l.amount_unit, base: l.base_qty * factor, percent: l.percent, cost: Math.round(l.cost * factor) }));
  return { formula: f, factor, lines, cost: lines.reduce((s, l) => s + l.cost, 0), problems: r.problems, safety: await formulas.safety(f.id) };
}

// Makes it up. Returns the dispensing id. Throws (status 400/409) with a readable message.
async function dispense({ patientId, caseId = null, formulaId, qty, unit, instructions, price, takeStock, bestBefore, staff }) {
  const p = await preview(formulaId, staff.id, qty, unit);
  if (p.error) throw Object.assign(new Error(p.error), { status: 400 });
  if (takeStock && p.problems.length) throw Object.assign(new Error(`Fix the formula first: ${p.problems.join(' ')}`), { status: 400 });
  const code = `D-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${token(3).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  const lots = [];
  let actualCost = p.cost;
  const { tx } = require('./db');
  return tx(async () => {
    if (takeStock) {
      actualCost = 0;
      for (const l of p.lines) {
        const taken = await inventory.consume(l.material_id, l.base, { kind: 'dispense', reason: `Dispensed ${code}`, staff: staff.name });
        for (const t of taken) { lots.push({ material: l.name, lot: t.lot_code, qty: t.qty }); actualCost += t.qty * t.unit_cost; }
      }
    }
    return insert(`INSERT INTO dispensings (patient_id, case_id, formula_id, formula_name, quantity, unit, instructions_enc, ingredients, lots, cost, price, code, best_before, dispensed_by, dispensed_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, patientId, caseId, p.formula.id, p.formula.name, Number(qty), unit, vault.seal({ text: String(instructions || '').slice(0, 2000) }),
    JSON.stringify(p.lines.map((l) => ({ name: l.name, amount: l.amount, unit: l.unit, percent: l.percent }))), JSON.stringify(lots), Math.round(actualCost), Math.max(0, price || 0), code, bestBefore || null, staff.id, staff.name);
  });
}

async function forPatient(patientId) {
  const rows = await all('SELECT d.*, i.number AS invoice_number FROM dispensings d LEFT JOIN invoices i ON i.id = d.invoice_id WHERE d.patient_id = ? ORDER BY d.id DESC', patientId);
  return rows.map((d) => ({ ...d, instructions: (vault.open(d.instructions_enc) || {}).text || '', ingredients: JSON.parse(d.ingredients || '[]'), lots: JSON.parse(d.lots || '[]') }));
}

module.exports = { preview, dispense, forPatient };
