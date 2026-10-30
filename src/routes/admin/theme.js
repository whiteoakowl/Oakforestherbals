'use strict';
// Theme editor: every storefront design setting, with a live preview beside the form.
const express = require('express');
const { get, all } = require('../../db');
const settings = require('../../settings');
const { upload, saveFile } = require('../../storage');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, asBool } = require('../../utils');

const router = express.Router();

const FONTS = ['Inter', 'Lato', 'Montserrat', 'Nunito', 'Open Sans', 'Poppins', 'Raleway', 'Work Sans', 'DM Sans',
  'Cormorant Garamond', 'Playfair Display', 'Lora', 'Merriweather', 'EB Garamond', 'Libre Baskerville', 'Fraunces'];
const IMAGE_FIELDS = ['logo', 'favicon', 'hero_image'];
const NUMBER_FIELDS = ['logo_width', 'button_radius', 'featured_count', 'products_per_page'];

router.get('/', async (req, res) => {
  res.render('admin/theme/index', { title: 'Themes' });
});

router.get('/customize', async (req, res) => {
  const collections = await all('SELECT handle, title FROM collections ORDER BY title');
  const product = await get("SELECT handle FROM products WHERE status = 'active' ORDER BY id LIMIT 1");
  res.render('admin/theme/customize', {
    title: 'Customize theme', FONTS, collections, t: settings.load('theme'), previewProduct: product ? product.handle : '',
  });
});

const fields = upload.fields(IMAGE_FIELDS.map((name) => ({ name: `${name}_file`, maxCount: 1 })));

router.post('/customize', fields, verifyCsrf, async (req, res) => {
  const current = settings.load('theme');
  const defaults = settings.DEFAULTS.theme;
  const patch = {};
  for (const key of Object.keys(defaults)) {
    if (typeof defaults[key] === 'boolean') patch[key] = asBool(req.body[key]);
    else if (NUMBER_FIELDS.includes(key)) patch[key] = Math.max(0, toInt(req.body[key], current[key]));
    else if (req.body[key] !== undefined) patch[key] = String(req.body[key]);
  }
  for (const key of IMAGE_FIELDS) {
    const file = req.files && req.files[`${key}_file`] && req.files[`${key}_file`][0];
    if (file) patch[key] = await saveFile(file);
    else if (asBool(req.body[`remove_${key}`])) patch[key] = '';
  }
  for (const key of ['font_heading', 'font_body']) if (!FONTS.includes(patch[key])) patch[key] = current[key];
  for (const key of Object.keys(patch)) if (key.startsWith('color_') && !/^#[0-9a-f]{6}$/i.test(patch[key])) patch[key] = current[key];
  await settings.save('theme', patch);
  flash(req, 'success', 'Theme saved.');
  res.redirect('/admin/themes/customize');
});

router.post('/reset', async (req, res) => {
  await settings.save('theme', structuredClone(settings.DEFAULTS.theme));
  flash(req, 'success', 'Theme reset to defaults.');
  res.redirect('/admin/themes/customize');
});

module.exports = router;
