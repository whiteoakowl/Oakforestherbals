'use strict';
const express = require('express');
const { get, all } = require('../../db');
const orders = require('../../orders');

const router = express.Router();

const RANGES = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

// Net sales, orders and visitors for the trailing `days` window, bucketed per day.
async function metrics(days) {
  const since = new Date(Date.now() - (days - 1) * 86400000);
  const sinceKey = dayKey(since);
  const rows = await all(`SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS orders, SUM(total - refunded_total) AS sales
    FROM orders WHERE status != 'cancelled' AND created_at >= ?::date GROUP BY day`, sinceKey);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const visitorRows = await all('SELECT day, COUNT(*) AS visitors FROM page_views WHERE day >= ? GROUP BY day', sinceKey);
  const visitorsByDay = new Map(visitorRows.map((r) => [r.day, r.visitors]));

  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000);
    const key = dayKey(d);
    const row = byDay.get(key);
    series.push({
      day: key,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      sales: row ? row.sales : 0,
      orders: row ? row.orders : 0,
      visitors: visitorsByDay.get(key) || 0,
    });
  }
  // Long ranges read better as weekly buckets.
  const bucketed = days > 90 ? bucket(series, 7) : series;
  const totalSales = series.reduce((s, d) => s + d.sales, 0);
  const totalOrders = series.reduce((s, d) => s + d.orders, 0);
  const visitors = series.reduce((s, d) => s + d.visitors, 0);
  return {
    series: bucketed,
    totalSales,
    totalOrders,
    visitors,
    aov: totalOrders ? Math.round(totalSales / totalOrders) : 0,
    conversion: visitors ? (totalOrders / visitors) * 100 : 0,
    sinceKey,
  };
}

function bucket(series, size) {
  const out = [];
  for (let i = 0; i < series.length; i += size) {
    const chunk = series.slice(i, i + size);
    out.push({
      day: chunk[0].day,
      label: `Week of ${chunk[0].label}`,
      sales: chunk.reduce((s, d) => s + d.sales, 0),
      orders: chunk.reduce((s, d) => s + d.orders, 0),
      visitors: chunk.reduce((s, d) => s + d.visitors, 0),
    });
  }
  return out;
}

function rangeFrom(req) {
  const r = Number(req.query.range);
  return RANGES[r] ? r : 30;
}

router.get('/', async (req, res) => {
  const range = rangeFrom(req);
  const m = await metrics(range);
  const recent = (await all('SELECT * FROM orders ORDER BY id DESC LIMIT 6')).map((o) => ({ ...o, name: orders.orderName(o) }));
  const todo = {
    unfulfilled: (await get("SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND fulfillment_status != 'fulfilled'")).n,
    pending: (await get("SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND financial_status = 'pending'")).n,
    lowStock: await all(`SELECT v.*, p.title AS product_title, p.id AS pid FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status = 'active' AND v.track_inventory = 1 AND v.inventory_qty <= 5 ORDER BY v.inventory_qty LIMIT 6`),
  };
  const productCount = (await get('SELECT COUNT(*) AS n FROM products')).n;
  res.render('admin/dashboard', { title: 'Home', range, RANGES, m, recent, todo, productCount });
});

router.get('/analytics', async (req, res) => {
  const range = rangeFrom(req);
  const m = await metrics(range);
  const topProducts = await all(`SELECT oi.title, SUM(oi.quantity) AS units, SUM(oi.price * oi.quantity) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'cancelled' AND o.created_at >= ?::date GROUP BY oi.title ORDER BY revenue DESC LIMIT 10`, m.sinceKey);
  const topCustomers = await all(`SELECT c.id, c.email, c.first_name, c.last_name, COUNT(o.id) AS orders, SUM(o.total - o.refunded_total) AS spent
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status != 'cancelled' AND o.created_at >= ?::date GROUP BY c.id ORDER BY spent DESC LIMIT 10`, m.sinceKey);
  const discountUse = await all(`SELECT discount_code AS code, COUNT(*) AS orders, SUM(discount_total) AS amount FROM orders
    WHERE discount_code != '' AND status != 'cancelled' AND created_at >= ?::date GROUP BY discount_code ORDER BY orders DESC`, m.sinceKey);
  const breakdown = await get(`SELECT COALESCE(SUM(subtotal), 0) AS gross, COALESCE(SUM(discount_total), 0) AS discounts,
    COALESCE(SUM(refunded_total), 0) AS refunds, COALESCE(SUM(shipping_total), 0) AS shipping, COALESCE(SUM(tax_total), 0) AS taxes
    FROM orders WHERE status != 'cancelled' AND created_at >= ?::date`, m.sinceKey);
  const returning = (await get(`SELECT COUNT(*) AS n FROM (SELECT customer_id FROM orders WHERE status != 'cancelled' AND customer_id IS NOT NULL
    GROUP BY customer_id HAVING COUNT(*) > 1) AS repeat_customers`)).n;
  res.render('admin/analytics', { title: 'Analytics', range, RANGES, m, topProducts, topCustomers, discountUse, breakdown, returning });
});

module.exports = router;
