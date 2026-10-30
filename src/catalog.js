'use strict';
// Read-side catalog helpers shared by the storefront and admin.
const { get, all } = require('./db');

// Postgres array literal for `= ANY(?::int[])`, which both database drivers accept as text.
const intArray = (ids) => `{${ids.map((id) => Number(id) | 0).join(',')}}`;

// Attaches variants, images and derived fields. Two queries total, however many products.
async function hydrateMany(products) {
  const list = products.filter(Boolean);
  if (!list.length) return list;
  const ids = intArray(list.map((p) => p.id));
  const [variants, images] = await Promise.all([
    all('SELECT * FROM variants WHERE product_id = ANY(?::int[]) ORDER BY position, id', ids),
    all('SELECT * FROM product_images WHERE product_id = ANY(?::int[]) ORDER BY position, id', ids),
  ]);
  for (const p of list) {
    decorate(p, variants.filter((v) => v.product_id === p.id), images.filter((i) => i.product_id === p.id));
  }
  return list;
}

async function hydrate(product) {
  if (!product) return null;
  return (await hydrateMany([product]))[0];
}

function decorate(product, variants, images) {
  product.options = JSON.parse(product.options || '[]');
  product.variants = variants;
  product.images = images;
  product.image = product.images[0] ? product.images[0].url : '';
  const prices = product.variants.map((v) => v.price);
  product.price_min = prices.length ? Math.min(...prices) : 0;
  product.price_max = prices.length ? Math.max(...prices) : 0;
  const compare = product.variants.map((v) => v.compare_at_price || 0);
  product.compare_at_max = compare.length ? Math.max(...compare) : 0;
  product.on_sale = product.variants.some((v) => v.compare_at_price && v.compare_at_price > v.price);
  product.available = product.variants.some(isVariantAvailable);
  product.inventory_total = product.variants.reduce((s, v) => s + (v.track_inventory ? v.inventory_qty : 0), 0);
  product.tag_list = product.tags ? product.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  return product;
}

function isVariantAvailable(v) {
  return !v.track_inventory || v.continue_selling || v.inventory_qty > 0;
}

async function productByHandle(handle, { includeDrafts = false } = {}) {
  const p = await get(`SELECT * FROM products WHERE handle = ? ${includeDrafts ? '' : "AND status = 'active'"}`, handle);
  return hydrate(p);
}

async function productById(id) {
  return hydrate(await get('SELECT * FROM products WHERE id = ?', id));
}

async function activeProducts() {
  return hydrateMany(await all("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC, id DESC"));
}

const RULE_FIELDS = {
  tag: (p) => p.tag_list.map((t) => t.toLowerCase()),
  type: (p) => [p.product_type.toLowerCase()],
  vendor: (p) => [p.vendor.toLowerCase()],
  title: (p) => [p.title.toLowerCase()],
  price: (p) => [p.price_min],
  inventory: (p) => [p.inventory_total],
};

function ruleMatches(product, rule) {
  const values = (RULE_FIELDS[rule.field] || (() => []))(product);
  const isNumeric = rule.field === 'price' || rule.field === 'inventory';
  const target = isNumeric
    ? (rule.field === 'price' ? Math.round(Number(rule.value) * 100) : Number(rule.value))
    : String(rule.value || '').toLowerCase();
  switch (rule.relation) {
    case 'equals': return values.some((v) => v === target);
    case 'not_equals': return values.every((v) => v !== target);
    case 'contains': return values.some((v) => String(v).includes(target));
    case 'greater_than': return values.some((v) => v > target);
    case 'less_than': return values.some((v) => v < target);
    default: return false;
  }
}

const SORTS = {
  'best-selling': null, // handled via order data
  'title-asc': (a, b) => a.title.localeCompare(b.title),
  'title-desc': (a, b) => b.title.localeCompare(a.title),
  'price-asc': (a, b) => a.price_min - b.price_min,
  'price-desc': (a, b) => b.price_min - a.price_min,
  'created-desc': (a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id,
  'created-asc': (a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id,
};

async function bestSellingRank() {
  const rows = await all(`SELECT product_id, SUM(quantity) AS qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' GROUP BY product_id`);
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

async function sortProducts(products, sort) {
  if (sort === 'best-selling') {
    const rank = await bestSellingRank();
    return products.sort((a, b) => (rank.get(b.id) || 0) - (rank.get(a.id) || 0));
  }
  return SORTS[sort] ? products.sort(SORTS[sort]) : products;
}

// Products in a collection, honoring manual membership or smart rules.
async function collectionProducts(collection, { includeDrafts = false } = {}) {
  if (!collection) return [];
  if (collection.kind === 'smart') {
    const rules = JSON.parse(collection.rules || '[]');
    const pool = includeDrafts ? await hydrateMany(await all('SELECT * FROM products')) : await activeProducts();
    const matched = rules.length === 0 ? pool : pool.filter((p) => (collection.match_any
      ? rules.some((r) => ruleMatches(p, r))
      : rules.every((r) => ruleMatches(p, r))));
    return sortProducts(matched, collection.sort_order === 'manual' ? 'created-desc' : collection.sort_order);
  }
  const rows = await all(`SELECT p.* FROM collection_products cp JOIN products p ON p.id = cp.product_id
    WHERE cp.collection_id = ? ${includeDrafts ? '' : "AND p.status = 'active'"} ORDER BY cp.position, p.id`, collection.id);
  const products = await hydrateMany(rows);
  return collection.sort_order === 'manual' ? products : sortProducts(products, collection.sort_order);
}

function collectionByHandle(handle) {
  return get('SELECT * FROM collections WHERE handle = ? AND published = 1', handle);
}

// All menus keyed by handle; loaded once per request for the header and footer.
async function menus() {
  const rows = await all('SELECT handle, items FROM menus');
  return Object.fromEntries(rows.map((r) => [r.handle, JSON.parse(r.items || '[]')]));
}

module.exports = {
  hydrate, hydrateMany, intArray, isVariantAvailable, productByHandle, productById, activeProducts,
  collectionProducts, collectionByHandle, sortProducts, ruleMatches, menus, SORTS,
};
