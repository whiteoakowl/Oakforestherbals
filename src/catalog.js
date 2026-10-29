'use strict';
// Read-side catalog helpers shared by the storefront and admin.
const { get, all } = require('./db');

function hydrate(product) {
  if (!product) return null;
  product.options = JSON.parse(product.options || '[]');
  product.variants = all('SELECT * FROM variants WHERE product_id = ? ORDER BY position, id', product.id);
  product.images = all('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id', product.id);
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

function productByHandle(handle, { includeDrafts = false } = {}) {
  const p = get(`SELECT * FROM products WHERE handle = ? ${includeDrafts ? '' : "AND status = 'active'"}`, handle);
  return hydrate(p);
}

function productById(id) {
  return hydrate(get('SELECT * FROM products WHERE id = ?', id));
}

function activeProducts() {
  return all("SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC, id DESC").map(hydrate);
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
  'created-desc': (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id,
  'created-asc': (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id,
};

function bestSellingRank() {
  const rows = all(`SELECT product_id, SUM(quantity) AS qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' GROUP BY product_id`);
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

function sortProducts(products, sort) {
  if (sort === 'best-selling') {
    const rank = bestSellingRank();
    return products.sort((a, b) => (rank.get(b.id) || 0) - (rank.get(a.id) || 0));
  }
  return SORTS[sort] ? products.sort(SORTS[sort]) : products;
}

// Products in a collection, honoring manual membership or smart rules.
function collectionProducts(collection, { includeDrafts = false } = {}) {
  if (!collection) return [];
  if (collection.kind === 'smart') {
    const rules = JSON.parse(collection.rules || '[]');
    const pool = includeDrafts ? all('SELECT * FROM products').map(hydrate) : activeProducts();
    const matched = rules.length === 0 ? pool : pool.filter((p) => (collection.match_any
      ? rules.some((r) => ruleMatches(p, r))
      : rules.every((r) => ruleMatches(p, r))));
    return sortProducts(matched, collection.sort_order === 'manual' ? 'created-desc' : collection.sort_order);
  }
  const rows = all(`SELECT p.* FROM collection_products cp JOIN products p ON p.id = cp.product_id
    WHERE cp.collection_id = ? ${includeDrafts ? '' : "AND p.status = 'active'"} ORDER BY cp.position, p.id`, collection.id);
  const products = rows.map(hydrate);
  return collection.sort_order === 'manual' ? products : sortProducts(products, collection.sort_order);
}

function collectionByHandle(handle) {
  return get('SELECT * FROM collections WHERE handle = ? AND published = 1', handle);
}

function menu(handle) {
  const row = get('SELECT * FROM menus WHERE handle = ?', handle);
  return row ? JSON.parse(row.items || '[]') : [];
}

module.exports = {
  hydrate, isVariantAvailable, productByHandle, productById, activeProducts,
  collectionProducts, collectionByHandle, sortProducts, ruleMatches, menu, SORTS,
};
