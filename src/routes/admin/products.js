'use strict';
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const catalog = require('../../catalog');
const { upload, csvUpload, saveFiles } = require('../../storage');
const { flash, verifyCsrf } = require('../../middleware');
const { parseMoney, toInt, uniqueHandle, parseTags, paginate, csvRow, parseCsv, asBool, asList, idFromKey, centsToInput } = require('../../utils');

const router = express.Router();

const STATUSES = ['active', 'draft', 'archived'];

router.get('/', async (req, res) => {
  const { q = '', status = '', type = '', vendor = '' } = req.query;
  const where = ['1 = 1'];
  const params = [];
  if (q) { where.push('(title ILIKE ? OR tags ILIKE ? OR handle ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (type) { where.push('product_type = ?'); params.push(type); }
  if (vendor) { where.push('vendor = ?'); params.push(vendor); }
  const sortMap = { title: 'lower(title)', '-title': 'lower(title) DESC', created: 'id', '-created': 'id DESC', updated: 'updated_at DESC' };
  const sort = sortMap[req.query.sort] ? req.query.sort : '-created';
  const total = (await get(`SELECT COUNT(*) AS n FROM products WHERE ${where.join(' AND ')}`, ...params)).n;
  const pager = paginate(total, req.query.page, 25);
  const products = await catalog.hydrateMany(await all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${sortMap[sort]} LIMIT ? OFFSET ?`,
    ...params, pager.perPage, pager.offset));
  const types = (await all("SELECT DISTINCT product_type AS v FROM products WHERE product_type != '' ORDER BY v")).map((r) => r.v);
  const vendors = (await all("SELECT DISTINCT vendor AS v FROM products WHERE vendor != '' ORDER BY v")).map((r) => r.v);
  const counts = Object.fromEntries((await all('SELECT status, COUNT(*) AS n FROM products GROUP BY status')).map((r) => [r.status, r.n]));
  res.render('admin/products/index', { title: 'Products', products, pager, types, vendors, counts, sort, filters: { q, status, type, vendor } });
});

router.post('/bulk', async (req, res) => {
  const ids = [].concat(req.body.ids || []).map((id) => toInt(id)).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) {
    flash(req, 'error', 'Select at least one product.');
    return res.redirect('/admin/products');
  }
  await tx(async () => {
    for (const id of ids) {
      if (STATUSES.includes(action)) await run("UPDATE products SET status = ?, updated_at = now() WHERE id = ?", action, id);
      if (action === 'delete') await run('DELETE FROM products WHERE id = ?', id);
    }
  });
  flash(req, 'success', `${ids.length} product(s) updated.`);
  res.redirect('/admin/products');
});

/* ---------- Inventory ---------- */

router.get('/inventory', async (req, res) => {
  const q = String(req.query.q || '');
  const rows = await all(`SELECT v.*, p.title AS product_title, p.id AS pid, p.status,
      (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position, id LIMIT 1) AS image
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE (p.title ILIKE ? OR v.sku ILIKE ?) ORDER BY lower(p.title), v.position`, `%${q}%`, `%${q}%`);
  res.render('admin/products/inventory', { title: 'Inventory', rows, q });
});

router.post('/inventory', async (req, res) => {
  const qty = req.body.qty || {};
  await tx(async () => {
    for (const [id, value] of Object.entries(qty)) {
      if (value !== '') await run('UPDATE variants SET inventory_qty = ? WHERE id = ?', toInt(value), idFromKey(id));
    }
  });
  flash(req, 'success', 'Inventory saved.');
  res.redirect('/admin/products/inventory');
});

/* ---------- CSV import / export ---------- */

const CSV_HEADER = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Status',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Variant Inventory Qty', 'Variant Grams', 'Image Src', 'SEO Title', 'SEO Description'];

router.get('/export.csv', async (req, res) => {
  const lines = [csvRow(CSV_HEADER)];
  for (const p of await catalog.hydrateMany(await all('SELECT * FROM products ORDER BY id'))) {
    p.variants.forEach((v, i) => {
      const first = i === 0;
      lines.push(csvRow([
        p.handle, first ? p.title : '', first ? p.description_html : '', first ? p.vendor : '', first ? p.product_type : '',
        first ? p.tags : '', first ? p.status : '',
        p.options[0] || '', v.option1 || '', p.options[1] || '', v.option2 || '', p.options[2] || '', v.option3 || '',
        v.sku, centsToInput(v.price), centsToInput(v.compare_at_price), v.inventory_qty, v.weight_grams,
        p.images[i] ? p.images[i].url : '', first ? p.seo_title : '', first ? p.seo_description : '',
      ]));
    });
  }
  res.attachment('products.csv').type('text/csv').send(lines.join('\n'));
});

router.post('/import', csvUpload.single('file'), verifyCsrf, async (req, res) => {
  if (!req.file) {
    flash(req, 'error', 'Choose a CSV file to import.');
    return res.redirect('/admin/products');
  }
  const rows = parseCsv(req.file.buffer.toString('utf8'));
  const byHandle = new Map();
  for (const row of rows) {
    const handle = row.Handle || row.Title;
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, []);
    byHandle.get(handle).push(row);
  }
  let created = 0;
  await tx(async () => {
    for (const [handle, group] of byHandle) {
      const head = group[0];
      if (await get('SELECT 1 FROM products WHERE handle = ?', handle)) continue;
      const options = [head['Option1 Name'], head['Option2 Name'], head['Option3 Name']].filter((o) => o && o !== 'Title');
      const status = STATUSES.includes(head.Status) ? head.Status : 'draft';
      const pid = await insert(`INSERT INTO products (title, handle, description_html, vendor, product_type, tags, status, options, seo_title, seo_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, head.Title || handle, await uniqueHandle('products', handle), head['Body (HTML)'] || '',
      head.Vendor || '', head.Type || '', head.Tags || '', status, JSON.stringify(options), head['SEO Title'] || '', head['SEO Description'] || '');
      for (const [i, row] of group.entries()) {
        const opts = [row['Option1 Value'], row['Option2 Value'], row['Option3 Value']].slice(0, options.length).map((o) => o || null);
        await run(`INSERT INTO variants (product_id, title, option1, option2, option3, sku, price, compare_at_price, inventory_qty, weight_grams, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, opts.filter(Boolean).join(' / ') || 'Default Title', opts[0] ?? null, opts[1] ?? null,
        opts[2] ?? null, row['Variant SKU'] || '', parseMoney(row['Variant Price']) || 0, parseMoney(row['Variant Compare At Price']),
        toInt(row['Variant Inventory Qty']), toInt(row['Variant Grams']), i);
        if (row['Image Src']) await run('INSERT INTO product_images (product_id, url, position) VALUES (?, ?, ?)', pid, row['Image Src'], i);
      }
      created++;
    }
  });
  flash(req, 'success', `Imported ${created} product(s). Existing handles were skipped.`);
  res.redirect('/admin/products');
});

/* ---------- Create / edit ---------- */

async function formData(product) {
  const collections = await all("SELECT id, title FROM collections WHERE kind = 'manual' ORDER BY title");
  const memberOf = product ? (await all('SELECT collection_id FROM collection_products WHERE product_id = ?', product.id)).map((r) => r.collection_id) : [];
  const types = (await all("SELECT DISTINCT product_type AS v FROM products WHERE product_type != '' ORDER BY v")).map((r) => r.v);
  const vendors = (await all("SELECT DISTINCT vendor AS v FROM products WHERE vendor != '' ORDER BY v")).map((r) => r.v);
  return { collections, memberOf, types, vendors, STATUSES };
}

router.get('/new', async (req, res) => {
  res.render('admin/products/edit', { title: 'Add product', product: null, ...await formData(null) });
});

router.get('/:id', async (req, res, next) => {
  const product = await catalog.productById(toInt(req.params.id));
  if (!product) return next();
  const sold = (await get('SELECT COALESCE(SUM(quantity), 0) AS n FROM order_items WHERE product_id = ?', product.id)).n;
  res.render('admin/products/edit', { title: product.title, product, sold, ...await formData(product) });
});

// Cartesian product of option values: [['S','M'],['Red']] -> [['S','Red'],['M','Red']].
function combinations(lists) {
  return lists.reduce((acc, values) => acc.flatMap((combo) => values.map((v) => [...combo, v])), [[]]);
}

function variantFields(src = {}, fallback = {}) {
  const pick = (k) => (src && src[k] !== undefined ? src[k] : fallback[k]);
  return {
    price: parseMoney(pick('price')) ?? 0,
    compare_at_price: parseMoney(pick('compare_at_price')),
    cost: parseMoney(pick('cost')),
    sku: String(pick('sku') || ''),
    barcode: String(pick('barcode') || ''),
    inventory_qty: toInt(pick('inventory_qty')),
    weight_grams: toInt(pick('weight_grams')),
  };
}

// A stored variant expressed the way the form posts it, used when a row was not submitted.
const asInput = (v) => ({ ...v, price: centsToInput(v.price), compare_at_price: centsToInput(v.compare_at_price), cost: centsToInput(v.cost) });

async function saveProduct(id, body, files) {
  const uploaded = await saveFiles(files); // upload before the transaction so it isn't held open
  const title = String(body.title || '').trim() || 'Untitled product';
  const status = STATUSES.includes(body.status) ? body.status : 'draft';
  const options = asList(body.options)
    .map((o) => ({ name: String(o.name || '').trim(), values: parseTags(o.values) }))
    .filter((o) => o.name && o.values.length)
    .slice(0, 3);
  const flags = {
    track_inventory: asBool(body.track_inventory) ? 1 : 0,
    continue_selling: asBool(body.continue_selling) ? 1 : 0,
    requires_shipping: asBool(body.requires_shipping) ? 1 : 0,
    taxable: asBool(body.taxable) ? 1 : 0,
  };

  return tx(async () => {
    const handle = await uniqueHandle('products', body.handle || title, id || 0);
    const values = [title, handle, String(body.description_html || ''), String(body.vendor || '').trim(),
      String(body.product_type || '').trim(), parseTags(body.tags).join(', '), status,
      JSON.stringify(options.map((o) => o.name)), String(body.seo_title || ''), String(body.seo_description || '')];
    if (id) {
      await run(`UPDATE products SET title = ?, handle = ?, description_html = ?, vendor = ?, product_type = ?, tags = ?, status = ?,
        options = ?, seo_title = ?, seo_description = ?, updated_at = now() WHERE id = ?`, ...values, id);
    } else {
      id = await insert(`INSERT INTO products (title, handle, description_html, vendor, product_type, tags, status, options, seo_title, seo_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values);
    }

    // Variants: one per option combination, keeping existing rows whose values still match.
    const existing = await all('SELECT * FROM variants WHERE product_id = ? ORDER BY position, id', id);
    const posted = body.variants || {};
    const combos = options.length ? combinations(options.map((o) => o.values)) : [[]];
    const keep = new Set();
    for (const [position, combo] of combos.entries()) {
      const [o1 = null, o2 = null, o3 = null] = combo;
      const match = options.length
        ? existing.find((v) => v.option1 === o1 && v.option2 === o2 && v.option3 === o3)
        : existing[0];
      let fields;
      if (!options.length) fields = variantFields(body);
      else if (match) fields = variantFields(posted[`id${match.id}`], asInput(match));
      else fields = { ...variantFields(body), sku: '', barcode: '', inventory_qty: 0 };
      const vtitle = combo.length ? combo.join(' / ') : 'Default Title';
      const cols = [vtitle, o1, o2, o3, fields.price, fields.compare_at_price, fields.cost, fields.sku, fields.barcode,
        fields.inventory_qty, fields.weight_grams, flags.track_inventory, flags.continue_selling, flags.requires_shipping,
        flags.taxable, position];
      if (match) {
        keep.add(match.id);
        await run(`UPDATE variants SET title = ?, option1 = ?, option2 = ?, option3 = ?, price = ?, compare_at_price = ?, cost = ?, sku = ?,
          barcode = ?, inventory_qty = ?, weight_grams = ?, track_inventory = ?, continue_selling = ?, requires_shipping = ?, taxable = ?,
          position = ? WHERE id = ?`, ...cols, match.id);
      } else {
        await run(`INSERT INTO variants (title, option1, option2, option3, price, compare_at_price, cost, sku, barcode, inventory_qty,
          weight_grams, track_inventory, continue_selling, requires_shipping, taxable, position, product_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols, id);
      }
    }
    for (const v of existing) if (!keep.has(v.id)) await run('DELETE FROM variants WHERE id = ?', v.id);

    // Media
    for (const imgId of [].concat(body.remove_images || [])) await run('DELETE FROM product_images WHERE id = ? AND product_id = ?', toInt(imgId), id);
    for (const [imgId, alt] of Object.entries(body.image_alt || {})) await run('UPDATE product_images SET alt = ? WHERE id = ? AND product_id = ?', String(alt), idFromKey(imgId), id);
    for (const [imgId, pos] of Object.entries(body.image_position || {})) await run('UPDATE product_images SET position = ? WHERE id = ? AND product_id = ?', toInt(pos), idFromKey(imgId), id);
    let next = ((await get('SELECT MAX(position) AS m FROM product_images WHERE product_id = ?', id)).m ?? -1) + 1;
    for (const url of uploaded) await run('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, ?)', id, url, title, next++);
    const imageUrl = String(body.image_url || '').trim();
    if (/^(https?:\/\/|\/)/.test(imageUrl)) await run('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, ?)', id, imageUrl, title, next++);

    // Manual collection membership
    const wanted = new Set([].concat(body.collections || []).map((c) => toInt(c)));
    for (const c of await all("SELECT id FROM collections WHERE kind = 'manual'")) {
      const member = await get('SELECT 1 FROM collection_products WHERE collection_id = ? AND product_id = ?', c.id, id);
      if (wanted.has(c.id) && !member) {
        const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collection_products WHERE collection_id = ?', c.id)).p;
        await run('INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)', c.id, id, pos);
      }
      if (!wanted.has(c.id) && member) await run('DELETE FROM collection_products WHERE collection_id = ? AND product_id = ?', c.id, id);
    }
    return id;
  });
}

router.post('/new', upload.array('images', 20), verifyCsrf, async (req, res) => {
  const id = await saveProduct(null, req.body, req.files);
  flash(req, 'success', 'Product created.');
  res.redirect(`/admin/products/${id}`);
});

router.post('/:id', upload.array('images', 20), verifyCsrf, async (req, res, next) => {
  const id = toInt(req.params.id);
  if (!await get('SELECT 1 FROM products WHERE id = ?', id)) return next();
  await saveProduct(id, req.body, req.files);
  flash(req, 'success', 'Product saved.');
  res.redirect(`/admin/products/${id}`);
});

router.post('/:id/duplicate', async (req, res, next) => {
  const p = await catalog.productById(toInt(req.params.id));
  if (!p) return next();
  const id = await tx(async () => {
    const newId = await insert(`INSERT INTO products (title, handle, description_html, vendor, product_type, tags, status, options, seo_title, seo_description)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`, `Copy of ${p.title}`, await uniqueHandle('products', `${p.handle}-copy`),
    p.description_html, p.vendor, p.product_type, p.tags, JSON.stringify(p.options), p.seo_title, p.seo_description);
    for (const v of p.variants) {
      await run(`INSERT INTO variants (product_id, title, option1, option2, option3, sku, barcode, price, compare_at_price, cost, inventory_qty,
        track_inventory, continue_selling, weight_grams, requires_shipping, taxable, position) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      newId, v.title, v.option1, v.option2, v.option3, v.price, v.compare_at_price, v.cost, v.track_inventory, v.continue_selling,
      v.weight_grams, v.requires_shipping, v.taxable, v.position);
    }
    for (const img of p.images) await run('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, ?)', newId, img.url, img.alt, img.position);
    return newId;
  });
  flash(req, 'success', 'Product duplicated as a draft.');
  res.redirect(`/admin/products/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  await run('DELETE FROM products WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Product deleted.');
  res.redirect('/admin/products');
});

module.exports = router;
