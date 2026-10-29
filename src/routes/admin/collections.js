'use strict';
const express = require('express');
const { get, all, run, tx } = require('../../db');
const catalog = require('../../catalog');
const { upload, fileUrl } = require('../../uploads');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, uniqueHandle, asBool, asList } = require('../../utils');

const router = express.Router();

const SORT_ORDERS = [
  ['manual', 'Manually'], ['best-selling', 'Best selling'], ['title-asc', 'Product title A-Z'], ['title-desc', 'Product title Z-A'],
  ['price-desc', 'Highest price'], ['price-asc', 'Lowest price'], ['created-desc', 'Newest'], ['created-asc', 'Oldest'],
];
const RULE_FIELDS = [['tag', 'Product tag'], ['type', 'Product type'], ['vendor', 'Product vendor'], ['title', 'Product title'], ['price', 'Product price'], ['inventory', 'Inventory stock']];
const RELATIONS = [['equals', 'is equal to'], ['not_equals', 'is not equal to'], ['contains', 'contains'], ['greater_than', 'is greater than'], ['less_than', 'is less than']];

router.get('/', (req, res) => {
  const q = String(req.query.q || '');
  const collections = all('SELECT * FROM collections WHERE title LIKE ? ORDER BY title COLLATE NOCASE', `%${q}%`)
    .map((c) => ({ ...c, count: catalog.collectionProducts(c, { includeDrafts: true }).length }));
  res.render('admin/collections/index', { title: 'Collections', collections, q });
});

function form(res, collection) {
  const products = collection ? catalog.collectionProducts(collection, { includeDrafts: true }) : [];
  const allProducts = all('SELECT id, title, status FROM products ORDER BY title COLLATE NOCASE');
  res.render('admin/collections/edit', {
    title: collection ? collection.title : 'Create collection',
    collection, products, allProducts, SORT_ORDERS, RULE_FIELDS, RELATIONS,
    rules: collection ? JSON.parse(collection.rules || '[]') : [],
  });
}

router.get('/new', (req, res) => form(res, null));
router.get('/:id', (req, res, next) => {
  const c = get('SELECT * FROM collections WHERE id = ?', toInt(req.params.id));
  return c ? form(res, c) : next();
});

function save(id, body, file) {
  const title = String(body.title || '').trim() || 'Untitled collection';
  const kind = body.kind === 'smart' ? 'smart' : 'manual';
  const rules = asList(body.rules)
    .filter((r) => r && r.field && r.relation && String(r.value || '').trim() !== '')
    .map((r) => ({ field: r.field, relation: r.relation, value: String(r.value).trim() }));
  const sort = SORT_ORDERS.some(([k]) => k === body.sort_order) ? body.sort_order : 'manual';
  return tx(() => {
    const handle = uniqueHandle('collections', body.handle || title, id || 0);
    const image = file ? fileUrl(file) : (body.remove_image ? '' : String(body.image || ''));
    const values = [title, handle, String(body.description_html || ''), image, kind, JSON.stringify(rules),
      body.match_any === '1' ? 1 : 0, sort, asBool(body.published) ? 1 : 0, String(body.seo_title || ''), String(body.seo_description || '')];
    if (id) {
      run(`UPDATE collections SET title = ?, handle = ?, description_html = ?, image = ?, kind = ?, rules = ?, match_any = ?,
        sort_order = ?, published = ?, seo_title = ?, seo_description = ? WHERE id = ?`, ...values, id);
    } else {
      id = Number(run(`INSERT INTO collections (title, handle, description_html, image, kind, rules, match_any, sort_order, published, seo_title, seo_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values).lastInsertRowid);
    }
    if (kind === 'manual') {
      // product_ids arrive in display order; that order becomes the manual sort.
      const ids = [].concat(body.product_ids || []).map((p) => toInt(p)).filter(Boolean);
      run('DELETE FROM collection_products WHERE collection_id = ?', id);
      [...new Set(ids)].forEach((pid, i) => run('INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)', id, pid, i));
    }
    return id;
  });
}

router.post('/new', upload.single('image_file'), verifyCsrf, (req, res) => {
  const id = save(null, req.body, req.file);
  flash(req, 'success', 'Collection created.');
  res.redirect(`/admin/collections/${id}`);
});

router.post('/:id', upload.single('image_file'), verifyCsrf, (req, res, next) => {
  const id = toInt(req.params.id);
  if (!get('SELECT 1 FROM collections WHERE id = ?', id)) return next();
  save(id, req.body, req.file);
  flash(req, 'success', 'Collection saved.');
  res.redirect(`/admin/collections/${id}`);
});

router.post('/:id/delete', (req, res) => {
  run('DELETE FROM collections WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Collection deleted.');
  res.redirect('/admin/collections');
});

module.exports = router;
