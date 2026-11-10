'use strict';
// Herbalist → Formulas: build, cost, scale, check safety, version and approve herbal formulas.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const formulas = require('../../formulas');
const costing = require('../../costing');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, asList } = require('../../utils');

const router = express.Router();
const { UNITS } = costing;

router.use((req, res, next) => {
  const can = res.locals.can;
  if (!can('formulas.view') && !can('formulas.manage')) {
    return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include formulas.' });
  }
  Object.assign(res.locals, { UNITS, CATEGORIES: formulas.CATEGORIES, MODES: formulas.MODES, canEditFormulas: can('formulas.manage'), canApprove: can('formulas.approve') });
  next();
});

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const text = (v, max = 20000) => String(v || '').trim().slice(0, max);
const fail = (req, res, msg, to) => { flash(req, 'error', msg); return res.redirect(to); };
const CAT_KEYS = formulas.CATEGORIES.map(([k]) => k);

function manage(req, res, next) {
  if (res.locals.can('formulas.manage')) return next();
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role can view formulas but not edit them.' });
}

router.get('/', async (req, res) => {
  const v = formulas.visibleSql(res.locals.staff.id);
  const where = [v.sql];
  const params = [...v.params];
  const q = String(req.query.q || '').trim();
  const status = ['draft', 'approved', 'archived'].includes(req.query.status) ? req.query.status : '';
  const category = CAT_KEYS.includes(req.query.category) ? req.query.category : '';
  if (q) { where.push('(f.name ILIKE ? OR EXISTS (SELECT 1 FROM formula_ingredients fi JOIN materials m ON m.id = fi.material_id WHERE fi.formula_id = f.id AND m.name ILIKE ?))'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('f.status = ?'); params.push(status); } else where.push("f.status != 'archived'");
  if (category) { where.push('f.category = ?'); params.push(category); }
  if (req.query.mine === '1') { where.push('f.owner_id = ?'); params.push(res.locals.staff.id); }
  const rows = await all(`SELECT f.*, s.name AS owner_name, (SELECT COUNT(*) FROM formula_ingredients fi WHERE fi.formula_id = f.id) AS ingredients
    FROM formulas f LEFT JOIN staff s ON s.id = f.owner_id WHERE ${where.join(' AND ')} ORDER BY lower(f.name)`, ...params);
  for (const f of rows) f.costing = await formulas.resolve(f);
  res.render('admin/formulas/index', { title: 'Formulas', rows, q, status, category, mine: req.query.mine === '1' });
});

function readFormula(body) {
  return {
    name: text(body.name, 200), category: CAT_KEYS.includes(body.category) ? body.category : 'other', description: text(body.description, 5000),
    entry_mode: ['amount', 'parts', 'percent'].includes(body.entry_mode) ? body.entry_mode : 'amount',
    yield_qty: num(body.yield_qty), yield_unit: UNITS[body.yield_unit] ? body.yield_unit : 'g', intended_use: text(body.intended_use, 2000),
    instructions: text(body.instructions), storage: text(body.storage, 1000), shelf_life_days: toInt(body.shelf_life_days) || null,
    labour_minutes: num(body.labour_minutes) || 0, practitioner_notes: text(body.practitioner_notes), safety_notes: text(body.safety_notes),
    visibility: body.visibility === 'private' ? 'private' : 'shared',
  };
}
const COLS = ['name', 'category', 'description', 'entry_mode', 'yield_qty', 'yield_unit', 'intended_use', 'instructions', 'storage', 'shelf_life_days', 'labour_minutes', 'practitioner_notes', 'safety_notes', 'visibility'];

async function readLines(body, f) {
  const lines = [];
  const errors = [];
  for (const [i, l] of asList(body.lines).entries()) {
    if (!l || !l.material_id || l.remove === '1') continue;
    const m = await get('SELECT * FROM materials WHERE id = ?', toInt(l.material_id));
    const q = num(l.quantity);
    if (!m) continue;
    if (!(q > 0)) { errors.push(`${m.name}: enter an amount above zero.`); continue; }
    if (m.formula_id && m.formula_id === f.id) { errors.push(`${m.name} is this formula's own output.`); continue; }
    const unit = f.entry_mode === 'amount' ? (UNITS[l.unit] ? l.unit : m.pack_unit) : f.yield_unit;
    if (costing.convert(1, unit, m.pack_unit) === null) { errors.push(`${m.name} is bought by ${UNITS[m.pack_unit].type}; measure it that way.`); continue; }
    lines.push({ material_id: m.id, quantity: q, unit, notes: text(l.notes, 300), position: i });
  }
  return { lines, errors };
}

async function formOptions() {
  return { materials: await all("SELECT id, name, kind, pack_unit, herb_id FROM materials WHERE archived = 0 ORDER BY kind = 'herb' DESC, lower(name)") };
}

router.get('/new', manage, async (req, res) => res.render('admin/formulas/edit', { title: 'New formula', formula: null, lines: [], ...await formOptions() }));

router.post('/new', manage, async (req, res) => {
  const f = readFormula(req.body);
  if (!f.name) return fail(req, res, 'Give the formula a name.', '/admin/formulas/new');
  if (!(f.yield_qty > 0)) return fail(req, res, 'Enter the batch yield (how much one batch makes).', '/admin/formulas/new');
  const id = await tx(async () => {
    const newId = await insert(`INSERT INTO formulas (${COLS.join(', ')}, owner_id) VALUES (${COLS.map(() => '?').join(', ')}, ?)`, ...COLS.map((c) => f[c]), res.locals.staff.id);
    const { lines } = await readLines(req.body, { ...f, id: newId });
    for (const l of lines) await run('INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, notes, position) VALUES (?, ?, ?, ?, ?, ?)', newId, l.material_id, l.quantity, l.unit, l.notes, l.position);
    return newId;
  });
  await audit.record(req, 'formula.created', { entityType: 'formula', entityId: id, details: { name: f.name } });
  flash(req, 'success', 'Formula saved as a draft. Add ingredients, then send it for approval.');
  res.redirect(`/admin/formulas/${id}`);
});

async function formulaParam(req, res, next) {
  const f = await get('SELECT f.*, s.name AS owner_name FROM formulas f LEFT JOIN staff s ON s.id = f.owner_id WHERE f.id = ?', toInt(req.params.id));
  if (!f || (f.visibility === 'private' && f.owner_id !== res.locals.staff.id)) {
    return res.status(404).render('admin/error', { title: 'Not found', message: 'This formula does not exist or is private to someone else.' });
  }
  f.yield_qty = Number(f.yield_qty);
  req.formula = f;
  next();
}

router.get('/:id', formulaParam, async (req, res) => {
  const f = req.formula;
  const resolved = await formulas.resolve(f);
  let scaled = null;
  const target = num(req.query.qty);
  if (target > 0 && UNITS[req.query.unit]) {
    const factor = formulas.scaleFactor(f, target, req.query.unit);
    if (factor === null) flash(req, 'error', `A ${UNITS[f.yield_unit].type} formula can't be scaled to ${UNITS[req.query.unit].label}.`);
    else scaled = { factor, qty: target, unit: req.query.unit };
  }
  const [safety, versions, batches, output] = await Promise.all([
    formulas.safety(f.id), all('SELECT id, version, note, saved_by, created_at FROM formula_versions WHERE formula_id = ? ORDER BY version DESC', f.id),
    all('SELECT id, code, status, planned_qty, actual_qty, actual_cost, created_at FROM production_batches WHERE formula_id = ? ORDER BY id DESC LIMIT 20', f.id),
    f.output_material_id ? get('SELECT * FROM materials WHERE id = ?', f.output_material_id) : null,
  ]);
  const usedBy = output ? await costing.variantsUsing(output.id) : [];
  res.locals.flash = res.locals.flash.concat(req.session.flash || []); req.session.flash = [];
  res.render('admin/formulas/show', { title: f.name, f, resolved, scaled, safety, versions, batches, output, usedBy });
});

router.get('/:id/sheet', formulaParam, async (req, res) => {
  const f = req.formula;
  const resolved = await formulas.resolve(f);
  const target = num(req.query.qty);
  const factor = target > 0 && UNITS[req.query.unit] ? formulas.scaleFactor(f, target, req.query.unit) || 1 : 1;
  res.render('admin/formulas/sheet', { title: `${f.name} — formula sheet`, f, resolved, factor, safety: await formulas.safety(f.id), target: factor === 1 ? null : { qty: target, unit: req.query.unit } });
});

function canEdit(res, f) {
  return res.locals.can('formulas.manage') && (f.visibility === 'shared' || f.owner_id === res.locals.staff.id);
}

router.get('/:id/edit', manage, formulaParam, async (req, res) => {
  const lines = await all('SELECT * FROM formula_ingredients WHERE formula_id = ? ORDER BY position, id', req.formula.id);
  res.render('admin/formulas/edit', { title: `Edit ${req.formula.name}`, formula: req.formula, lines: lines.map((l) => ({ ...l, quantity: Number(l.quantity) })), ...await formOptions() });
});

router.post('/:id/edit', manage, formulaParam, async (req, res) => {
  const old = req.formula;
  const back = `/admin/formulas/${old.id}`;
  if (!canEdit(res, old)) return fail(req, res, 'You can only edit shared formulas or your own.', back);
  const f = readFormula(req.body);
  if (!f.name || !(f.yield_qty > 0)) return fail(req, res, 'A formula needs a name and a yield above zero.', `${back}/edit`);
  const { lines, errors } = await readLines(req.body, { ...f, id: old.id });
  if (errors.length) return fail(req, res, errors.join(' '), `${back}/edit`);
  // Changing an approved formula starts a new draft version; the approved version stays in history.
  const newVersion = old.status === 'approved' ? old.version + 1 : old.version;
  await tx(async () => {
    await run(`UPDATE formulas SET ${COLS.map((c) => `${c} = ?`).join(', ')}, status = 'draft', version = ?, reviewed_by = '', reviewed_at = NULL, updated_at = now() WHERE id = ?`,
      ...COLS.map((c) => f[c]), newVersion, old.id);
    await run('DELETE FROM formula_ingredients WHERE formula_id = ?', old.id);
    for (const l of lines) await run('INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, notes, position) VALUES (?, ?, ?, ?, ?, ?)', old.id, l.material_id, l.quantity, l.unit, l.notes, l.position);
    await formulas.refreshOutputPrice(old.id);
  });
  await audit.record(req, 'formula.updated', { entityType: 'formula', entityId: old.id, details: { version: newVersion } });
  flash(req, 'success', old.status === 'approved' ? `Saved as draft version ${newVersion}. It needs approval again before production.` : 'Formula saved.');
  res.redirect(back);
});

router.post('/:id/approve', formulaParam, async (req, res) => {
  const f = req.formula;
  const back = `/admin/formulas/${f.id}`;
  if (!res.locals.can('formulas.approve')) return fail(req, res, 'Your role cannot approve formulas.', back);
  const r = await formulas.resolve(f);
  if (!r.lines.length) return fail(req, res, 'Add ingredients before approving.', back);
  if (r.problems.length) return fail(req, res, r.problems.join(' '), back);
  if (req.body.reviewed_safety !== '1') return fail(req, res, 'Confirm you have reviewed the safety information for every ingredient.', back);
  await run("UPDATE formulas SET status = 'approved', reviewed_by = ?, reviewed_at = now() WHERE id = ?", res.locals.staff.name, f.id);
  await formulas.saveVersion(f.id, text(req.body.note, 500) || 'Approved', res.locals.staff.name);
  await audit.record(req, 'formula.approved', { entityType: 'formula', entityId: f.id, details: { version: f.version } });
  flash(req, 'success', `Version ${f.version} approved. It can now be produced and recommended.`);
  res.redirect(back);
});

router.post('/:id/status', manage, formulaParam, async (req, res) => {
  const f = req.formula;
  if (!canEdit(res, f)) return fail(req, res, 'You can only change shared formulas or your own.', `/admin/formulas/${f.id}`);
  const to = req.body.status === 'archived' ? 'archived' : 'draft';
  await run('UPDATE formulas SET status = ? WHERE id = ?', to, f.id);
  flash(req, 'success', to === 'archived' ? 'Formula archived.' : 'Formula restored as a draft.');
  res.redirect(`/admin/formulas/${f.id}`);
});

router.post('/:id/component', manage, formulaParam, async (req, res) => {
  const id = await formulas.createOutputMaterial(req.formula.id);
  flash(req, 'success', 'Component created. Use it in product recipes; its cost follows this formula.');
  res.redirect(`/admin/costing/materials/${id}`);
});

router.post('/:id/duplicate', manage, formulaParam, async (req, res) => {
  const f = req.formula;
  const id = await tx(async () => {
    const newId = await insert(`INSERT INTO formulas (${COLS.join(', ')}, owner_id) VALUES (${COLS.map(() => '?').join(', ')}, ?)`, ...COLS.map((c) => (c === 'name' ? `Copy of ${f.name}` : f[c])), res.locals.staff.id);
    await run('INSERT INTO formula_ingredients (formula_id, material_id, quantity, unit, notes, position) SELECT ?, material_id, quantity, unit, notes, position FROM formula_ingredients WHERE formula_id = ?', newId, f.id);
    return newId;
  });
  flash(req, 'success', 'Copied as a new draft.');
  res.redirect(`/admin/formulas/${id}`);
});

router.get('/:id/versions/:version', formulaParam, async (req, res, next) => {
  const v = await get('SELECT * FROM formula_versions WHERE formula_id = ? AND version = ?', req.formula.id, toInt(req.params.version));
  if (!v) return next();
  const snap = JSON.parse(v.snapshot);
  const ids = snap.ingredients.map((i) => i.material_id);
  const names = new Map((ids.length ? await all('SELECT id, name FROM materials WHERE id = ANY(?::int[])', `{${ids.join(',')}}`) : []).map((m) => [m.id, m.name]));
  res.render('admin/formulas/version', { title: `${req.formula.name} v${v.version}`, f: req.formula, v, snap, names });
});

module.exports = router;
