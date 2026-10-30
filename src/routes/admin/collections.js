'use strict';
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const catalog = require('../../catalog');
const { upload, saveFile } = require('../../storage');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, uniqueHandle, asBool, asList } = require('../../utils');

const router = express.Router();

const SORT_ORDERS = [
  ['manual', 'Manually'], ['best-selling', 'Best selling'], ['title-asc', 'Product title A-Z'], ['title-desc', 'Product title Z-A'],
  ['price-desc', 'Highest price'], ['price-asc', 'Lowest price'], ['created-desc', 'Newest'], ['created-asc', 'Oldest'],
];
const RULE_FIELDS = [['tag', 'Product tag'], ['type', 'Product type'], ['vendor', 'Product vendor'], ['title', 'Product title'], ['price', 'Product price'], ['inventory', 'Inventory stock']];
const RELATIONS = [['equals', 'is equal to'], ['not_equals', 'is not equal to'], ['contains', 'contains'], ['greater_than', 'is greater than'], ['less_than', 'is less than']];

router.get('/', async (req, res) => {
  const q = String(req.query.q || '');
  const rows = await all('SELECT * FROM collections WHERE title ILIKE ? ORDER BY lower(title)', `%${q}%`);
  // Count members without re-querying per collection: manual counts in SQL, smart rules in memory.
  const manualCounts = new Map((await all('SELECT collection_id, COUNT(*) AS n FROM collection_products GROUP BY collection_id'))
    .map((r) => [r.collection_id, r.n]));
  const pool = rows.some((c) => c.kind === 'smart') ? await catalog.hydrateMany(await all('SELECT * FROM products')) : [];
  const collections = rows.map((c) => {
    if (c.kind !== 'smart') return { ...c, count: manualCounts.get(c.id) || 0 };
    const rules = JSON.parse(c.rules || '[]');
    const count = pool.filter((p) => !rules.length || (c.match_any
      ? rules.some((r) => catalog.ruleMatches(p, r)) : rules.every((r) => catalog.ruleMatches(p, r)))).length;
    return { ...c, count };
  });
  res.render('admin/collections/index', { title: 'Collections', collections, q });
});

async function form(res, collection) {
  const products = collection ? await catalog.collectionProducts(collection, { includeDrafts: true }) : [];
  const allProducts = await all('SELECT id, title, status FROM products ORDER BY lower(title)');
  res.render('admin/collections/edit', {
    title: collection ? collection.title : 'Create collection',
    collection, products, allProducts, SORT_ORDERS, RULE_FIELDS, RELATIONS,
    rules: collection ? JSON.parse(collection.rules || '[]') : [],
  });
}

router.get('/new', (req, res) => form(res, null));
router.get('/:id', async (req, res, next) => {
  const c = await get('SELECT * FROM collections WHERE id = ?', toInt(req.params.id));
  return c ? form(res, c) : next();
});

async function save(id, body, file) {
  const uploadedImage = await saveFile(file);
  const title = String(body.title || '').trim() || 'Untitled collection';
  const kind = body.kind === 'smart' ? 'smart' : 'manual';
  const rules = asList(body.rules)
    .filter((r) => r && r.field && r.relation && String(r.value || '').trim() !== '')
    .map((r) => ({ field: r.field, relation: r.relation, value: String(r.value).trim() }));
  const sort = SORT_ORDERS.some(([k]) => k === body.sort_order) ? body.sort_order : 'manual';
  return tx(async () => {
    const handle = await uniqueHandle('collections', body.handle || title, id || 0);
    const image = uploadedImage || (body.remove_image ? '' : String(body.image || ''));
    const values = [title, handle, String(body.description_html || ''), image, kind, JSON.stringify(rules),
      body.match_any === '1' ? 1 : 0, sort, asBool(body.published) ? 1 : 0, String(body.seo_title || ''), String(body.seo_description || '')];
    if (id) {
      await run(`UPDATE collections SET title = ?, handle = ?, description_html = ?, image = ?, kind = ?, rules = ?, match_any = ?,
        sort_order = ?, published = ?, seo_title = ?, seo_description = ? WHERE id = ?`, ...values, id);
    } else {
      id = await insert(`INSERT INTO collections (title, handle, description_html, image, kind, rules, match_any, sort_order, published, seo_title, seo_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values);
    }
    if (kind === 'manual') {
      // product_ids arrive in display order; that order becomes the manual sort.
      const ids = [].concat(body.product_ids || []).map((p) => toInt(p)).filter(Boolean);
      await run('DELETE FROM collection_products WHERE collection_id = ?', id);
      for (const [i, pid] of [...new Set(ids)].entries()) {
        await run('INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)', id, pid, i);
      }
    }
    return id;
  });
}

router.post('/new', upload.single('image_file'), verifyCsrf, async (req, res) => {
  const id = await save(null, req.body, req.file);
  flash(req, 'success', 'Collection created.');
  res.redirect(`/admin/collections/${id}`);
});

router.post('/:id', upload.single('image_file'), verifyCsrf, async (req, res, next) => {
  const id = toInt(req.params.id);
  if (!await get('SELECT 1 FROM collections WHERE id = ?', id)) return next();
  await save(id, req.body, req.file);
  flash(req, 'success', 'Collection saved.');
  res.redirect(`/admin/collections/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  await run('DELETE FROM collections WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Collection deleted.');
  res.redirect('/admin/collections');
});

module.exports = router;
