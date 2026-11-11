'use strict';
// Apothecary → Fullscript: the dispensary address and the supplement library used in care plans.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const fullscript = require('../../fullscript');
const settings = require('../../settings');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, asBool } = require('../../utils');

const router = express.Router();
const text = (v, max = 2000) => String(v || '').trim().slice(0, max);

router.get('/', async (req, res) => {
  const list = await fullscript.library(true);
  const usage = Object.fromEntries((await all('SELECT fullscript_product_id AS id, COUNT(*) AS n FROM care_plan_items WHERE fullscript_product_id IS NOT NULL GROUP BY fullscript_product_id')).map((r) => [r.id, Number(r.n)]));
  const herbs = await all("SELECT id, common_name FROM herbs WHERE status = 'published' ORDER BY lower(common_name)");
  res.render('admin/fullscript', { title: 'Fullscript dispensary', cfg: fullscript.config(), list, usage, herbs, edit: toInt(req.query.edit), connected: fullscript.enabled() });
});

router.post('/settings', async (req, res) => {
  const url = text(req.body.dispensary_url, 500);
  const clean = url ? fullscript.cleanUrl(url) : '';
  if (url && !clean) { flash(req, 'error', 'Paste your dispensary address from Fullscript — it starts with https:// and ends in fullscript.com/…'); return res.redirect('/admin/fullscript'); }
  await settings.save('fullscript', { enabled: asBool(req.body.enabled) && Boolean(clean), dispensary_url: clean || '', label: text(req.body.label, 100) || 'Our Fullscript dispensary', note: text(req.body.note, 500) });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'fullscript' });
  flash(req, 'success', 'Fullscript settings saved.');
  res.redirect('/admin/fullscript');
});

router.post('/products', async (req, res) => {
  const name = text(req.body.name, 200);
  const url = fullscript.cleanUrl(req.body.url);
  if (!name || !url) { flash(req, 'error', 'Give the product a name and paste its Fullscript link (https://…fullscript.com/…).'); return res.redirect('/admin/fullscript'); }
  const herb = toInt(req.body.herb_id) && await get('SELECT id FROM herbs WHERE id = ?', toInt(req.body.herb_id));
  const cols = [name, text(req.body.brand, 120), url, text(req.body.default_dose, 200), text(req.body.notes), herb ? herb.id : null];
  if (toInt(req.body.id)) await run('UPDATE fullscript_products SET name = ?, brand = ?, url = ?, default_dose = ?, notes = ?, herb_id = ?, active = ? WHERE id = ?', ...cols, req.body.active === '0' ? 0 : 1, toInt(req.body.id));
  else await insert('INSERT INTO fullscript_products (name, brand, url, default_dose, notes, herb_id) VALUES (?, ?, ?, ?, ?, ?)', ...cols);
  flash(req, 'success', 'Supplement saved.');
  res.redirect('/admin/fullscript');
});

module.exports = router;
