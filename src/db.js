'use strict';
// SQLite connection, schema and small query helpers (uses Node's built-in node:sqlite).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  accepts_marketing INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  address1 TEXT NOT NULL DEFAULT '',
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'US',
  phone TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  description_html TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  options TEXT NOT NULL DEFAULT '[]',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Default Title',
  option1 TEXT,
  option2 TEXT,
  option3 TEXT,
  sku TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  compare_at_price INTEGER,
  cost INTEGER,
  inventory_qty INTEGER NOT NULL DEFAULT 0,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  continue_selling INTEGER NOT NULL DEFAULT 0,
  weight_grams INTEGER NOT NULL DEFAULT 0,
  requires_shipping INTEGER NOT NULL DEFAULT 1,
  taxable INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  description_html TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'manual',
  rules TEXT NOT NULL DEFAULT '[]',
  match_any INTEGER NOT NULL DEFAULT 0,
  sort_order TEXT NOT NULL DEFAULT 'manual',
  published INTEGER NOT NULL DEFAULT 1,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collection_products (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  financial_status TEXT NOT NULL DEFAULT 'pending',
  fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',
  status TEXT NOT NULL DEFAULT 'open',
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  shipping_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  refunded_total INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT NOT NULL DEFAULT '',
  shipping_method TEXT NOT NULL DEFAULT '',
  shipping_address TEXT NOT NULL DEFAULT '{}',
  billing_address TEXT NOT NULL DEFAULT '{}',
  payment_method TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  variant_id INTEGER,
  title TEXT NOT NULL,
  variant_title TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  fulfilled_qty INTEGER NOT NULL DEFAULT 0,
  requires_shipping INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fulfillments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tracking_company TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'percentage',
  value INTEGER NOT NULL DEFAULT 0,
  min_subtotal INTEGER NOT NULL DEFAULT 0,
  usage_limit INTEGER,
  once_per_customer INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  body_html TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS shipping_rates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  min_subtotal INTEGER NOT NULL DEFAULT 0,
  max_subtotal INTEGER,
  countries TEXT NOT NULL DEFAULT '*',
  delivery_estimate TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY,
  country TEXT NOT NULL,
  province TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Tax',
  rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS page_views (
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, visitor)
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
`;

db.exec(SCHEMA);

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

// Runs fn inside a transaction; nested calls join the outer transaction.
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

module.exports = { db, get, all, run, tx };
