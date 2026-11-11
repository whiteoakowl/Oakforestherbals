'use strict';
// Store → Costing → Profitability: margin per product and per category, plus what was actually
// earned on units sold in the chosen period.
const express = require('express');
const { all } = require('../../db');
const { margin } = require('../../costing');
const { csvRow, centsToInput } = require('../../utils');

const router = express.Router();
const RANGES = { 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months', all: 'All time' };

async function report(range) {
  const since = range === 'all' ? null : new Date(Date.now() - Number(range) * 86400000).toISOString();
  // Sold lines use the cost captured at sale time; older orders (before costing existed) fall back
  // to today's cost and are marked as estimates.
  const rows = await all(`SELECT v.id, v.title, v.price, v.wholesale_price, v.cost, p.id AS product_id, p.title AS product_title,
      COALESCE(NULLIF(p.product_type, ''), 'Uncategorised') AS category,
      COALESCE(s.units, 0) AS units, COALESCE(s.revenue, 0) AS revenue, COALESCE(s.cogs, 0) AS cogs,
      COALESCE(s.estimated_units, 0) AS estimated_units, COALESCE(s.uncosted_units, 0) AS uncosted_units
    FROM variants v JOIN products p ON p.id = v.product_id
    LEFT JOIN (
      SELECT oi.variant_id, SUM(oi.quantity) AS units, SUM(oi.price * oi.quantity) AS revenue,
        SUM(COALESCE(oi.unit_cost, v2.cost, 0) * oi.quantity) AS cogs,
        SUM(CASE WHEN oi.unit_cost IS NULL AND v2.cost IS NOT NULL THEN oi.quantity ELSE 0 END) AS estimated_units,
        SUM(CASE WHEN oi.unit_cost IS NULL AND v2.cost IS NULL THEN oi.quantity ELSE 0 END) AS uncosted_units
      FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN variants v2 ON v2.id = oi.variant_id
      WHERE o.status != 'cancelled' ${since ? 'AND o.created_at >= ?' : ''}
      GROUP BY oi.variant_id
    ) s ON s.variant_id = v.id
    WHERE p.status != 'archived'
    ORDER BY lower(p.title), v.position`, ...(since ? [since] : []));
  for (const r of rows) {
    r.retail = margin(r.price, r.cost);
    r.wholesale = margin(r.wholesale_price, r.cost);
    r.profit = r.revenue - r.cogs;
  }
  const categories = new Map();
  for (const r of rows) {
    const c = categories.get(r.category) || { category: r.category, units: 0, revenue: 0, cogs: 0, variants: 0, uncosted: 0 };
    c.units += r.units; c.revenue += r.revenue; c.cogs += r.cogs; c.variants++;
    if (r.cost === null) c.uncosted++;
    categories.set(r.category, c);
  }
  const cats = [...categories.values()].map((c) => ({ ...c, profit: c.revenue - c.cogs, percent: c.revenue ? Math.round(((c.revenue - c.cogs) / c.revenue) * 1000) / 10 : null }))
    .sort((a, b) => b.profit - a.profit);
  const totals = cats.reduce((t, c) => ({ units: t.units + c.units, revenue: t.revenue + c.revenue, cogs: t.cogs + c.cogs }), { units: 0, revenue: 0, cogs: 0 });
  totals.profit = totals.revenue - totals.cogs;
  totals.percent = totals.revenue ? Math.round((totals.profit / totals.revenue) * 1000) / 10 : null;
  return { rows, cats, totals };
}

const rangeOf = (q) => (Object.hasOwn(RANGES, q) ? q : '90');

router.get('/', async (req, res) => {
  const range = rangeOf(req.query.range);
  const data = await report(range);
  const sort = req.query.sort === 'margin' ? 'margin' : req.query.sort === 'profit' ? 'profit' : 'name';
  if (sort === 'margin') data.rows.sort((a, b) => (a.retail ? a.retail.percent : 999) - (b.retail ? b.retail.percent : 999));
  if (sort === 'profit') data.rows.sort((a, b) => b.profit - a.profit);
  res.render('admin/costing/profitability', { title: 'Profitability', ...data, range, RANGES, sort });
});

router.get('/export.csv', async (req, res) => {
  const { rows } = await report(rangeOf(req.query.range));
  const lines = [csvRow(['Product', 'Variant', 'Category', 'Price', 'Wholesale price', 'Cost', 'Retail margin %', 'Wholesale margin %', 'Units sold', 'Revenue', 'Cost of goods', 'Gross profit'])];
  for (const r of rows) {
    lines.push(csvRow([r.product_title, r.title, r.category, centsToInput(r.price), centsToInput(r.wholesale_price), centsToInput(r.cost),
      r.retail ? r.retail.percent : '', r.wholesale ? r.wholesale.percent : '', r.units, centsToInput(r.revenue), centsToInput(r.cogs), centsToInput(r.profit)]));
  }
  res.attachment('profitability.csv').type('text/csv').send(lines.join('\n'));
});

module.exports = router;
