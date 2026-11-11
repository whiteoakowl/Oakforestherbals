'use strict';
// Product reviews from customers. Verified when the reviewer has a paid order containing the product.
// Shown only once published (automatically, or after a staff member approves them).
const { get, all, run } = require('./db');
const settings = require('./settings');

async function summary(productId) {
  const r = await get("SELECT COUNT(*) AS n, AVG(rating) AS avg FROM product_reviews WHERE product_id = ? AND status = 'published'", productId);
  return { count: Number(r.n), average: r.avg === null ? null : Math.round(Number(r.avg) * 10) / 10 };
}

const published = (productId) => all("SELECT * FROM product_reviews WHERE product_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 50", productId);

async function purchased(customerId, productId) {
  return Boolean(await get(`SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = ? AND i.product_id = ?
    AND o.status != 'cancelled' AND o.financial_status IN ('paid', 'partially_refunded') LIMIT 1`, customerId, productId));
}

// { allowed, verified, existing, reason }
async function eligibility(customer, productId) {
  const cfg = settings.load('reviews');
  if (!cfg.enabled) return { allowed: false, reason: 'disabled' };
  if (!customer) return { allowed: false, reason: 'login' };
  const verified = await purchased(customer.id, productId);
  if (cfg.require_purchase && !verified) return { allowed: false, reason: 'purchase' };
  const existing = await get('SELECT * FROM product_reviews WHERE product_id = ? AND customer_id = ?', productId, customer.id);
  return { allowed: true, verified, existing };
}

async function submit(customer, productId, { rating, title, body }) {
  const e = await eligibility(customer, productId);
  if (!e.allowed) return { error: 'You can’t review this product.' };
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return { error: 'Choose a rating from 1 to 5 stars.' };
  const status = settings.load('reviews').auto_publish ? 'published' : 'pending';
  const name = `${customer.first_name || ''} ${(customer.last_name || '').slice(0, 1)}${customer.last_name ? '.' : ''}`.trim() || 'Customer';
  await run(`INSERT INTO product_reviews (product_id, customer_id, rating, title, body, author_name, verified, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (product_id, customer_id) DO UPDATE SET rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body, verified = EXCLUDED.verified,
    status = EXCLUDED.status, updated_at = now()`, productId, customer.id, r, String(title || '').trim().slice(0, 150), String(body || '').trim().slice(0, 5000), name, e.verified ? 1 : 0, status);
  return { status };
}

module.exports = { summary, published, eligibility, submit };
