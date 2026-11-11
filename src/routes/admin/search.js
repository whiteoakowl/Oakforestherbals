'use strict';
// Search everything from the top bar. Each group only appears for people allowed to see it, and
// clinic clients only include those the person can already open.
const express = require('express');
const { all } = require('../../db');
const clinic = require('../../clinic');
const herbs = require('../../herbs');
const formulas = require('../../formulas');
const audit = require('../../audit');

const router = express.Router();
const LIMIT = 8;

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const can = res.locals.can;
  const staff = res.locals.staff;
  const groups = [];
  if (q.length >= 2) {
    const like = `%${q}%`;
    const num = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : -1;
    if (clinic.canSeeAny(staff)) {
      const s = clinic.scope(staff);
      const rows = await all(`SELECT p.id, c.first_name, c.last_name, c.email, p.status FROM patients p JOIN customers c ON c.id = p.customer_id
        WHERE ${s.sql} AND ((c.first_name || ' ' || c.last_name) ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ?) ORDER BY lower(c.first_name) LIMIT ?`, ...s.params, like, like, like, LIMIT);
      if (rows.length) await audit.record(req, 'clinic.search', { details: { results: rows.length } });
      groups.push({ label: 'Clients', more: `/admin/clinic/patients?q=${encodeURIComponent(q)}`, hits: rows.map((r) => ({ href: `/admin/clinic/patients/${r.id}`, title: `${r.first_name} ${r.last_name}`.trim() || r.email, sub: `${r.email}${r.status !== 'active' ? ` · ${r.status}` : ''}`, initials: true })) });
    }
    if (can('customers.view') || can('customers.manage')) {
      const rows = await all(`SELECT id, first_name, last_name, email FROM customers WHERE (first_name || ' ' || last_name) ILIKE ? OR email ILIKE ? OR phone ILIKE ? ORDER BY lower(first_name) LIMIT ?`, like, like, like, LIMIT);
      groups.push({ label: 'Customers', more: `/admin/customers?q=${encodeURIComponent(q)}`, hits: rows.map((r) => ({ href: `/admin/customers/${r.id}`, title: `${r.first_name} ${r.last_name}`.trim() || r.email, sub: r.email, initials: true })) });
    }
    if (can('orders.view') || can('orders.manage')) {
      const rows = await all('SELECT id, number, email, total, financial_status FROM orders WHERE number = ? OR email ILIKE ? ORDER BY id DESC LIMIT ?', num, like, LIMIT);
      groups.push({ label: 'Orders', more: `/admin/orders?q=${encodeURIComponent(q)}`, hits: rows.map((r) => ({ href: `/admin/orders/${r.id}`, title: `Order #${r.number}`, sub: `${r.email} · ${res.locals.money(r.total)} · ${r.financial_status.replace('_', ' ')}` })) });
    }
    if (can('invoices.manage')) {
      const rows = await all('SELECT id, number, name, email, total, status FROM invoices WHERE number = ? OR name ILIKE ? OR email ILIKE ? ORDER BY id DESC LIMIT ?', num, like, like, LIMIT);
      groups.push({ label: 'Invoices', more: '/admin/invoices', hits: rows.map((r) => ({ href: `/admin/invoices/${r.id}`, title: `Invoice #${r.number}`, sub: `${r.name || r.email} · ${res.locals.money(r.total)} · ${r.status}` })) });
    }
    if (can('products.manage')) {
      const rows = await all('SELECT DISTINCT p.id, p.title, p.status FROM products p LEFT JOIN variants v ON v.product_id = p.id WHERE p.title ILIKE ? OR v.sku ILIKE ? OR v.barcode = ? ORDER BY p.title LIMIT ?', like, like, q, LIMIT);
      groups.push({ label: 'Products', more: `/admin/products?q=${encodeURIComponent(q)}`, hits: rows.map((r) => ({ href: `/admin/products/${r.id}`, title: r.title, sub: r.status })) });
    }
    if (can('herbs.view') || can('herbs.manage')) {
      const { rows } = await herbs.search(herbs.parseQuery({ q }), { limit: LIMIT });
      groups.push({ label: 'Herbs', more: `/admin/herbs?q=${encodeURIComponent(q)}`, hits: rows.map((h) => ({ href: `/admin/herbs/${h.slug}`, title: h.common_name, sub: h.latin_name || '' })) });
    }
    if (can('formulas.view') || can('formulas.manage')) {
      const v = formulas.visibleSql(staff.id);
      const rows = await all(`SELECT f.id, f.name, f.status FROM formulas f WHERE f.name ILIKE ? AND ${v.sql} ORDER BY f.name LIMIT ?`, like, ...v.params, LIMIT);
      groups.push({ label: 'Formulas', more: '/admin/formulas', hits: rows.map((r) => ({ href: `/admin/formulas/${r.id}`, title: r.name, sub: r.status })) });
    }
    if (can('inventory.manage')) {
      const rows = await all('SELECT id, name, kind FROM materials WHERE archived = 0 AND (name ILIKE ? OR sku ILIKE ? OR botanical_name ILIKE ?) ORDER BY name LIMIT ?', like, like, like, LIMIT);
      groups.push({ label: 'Materials', more: `/admin/inventory?q=${encodeURIComponent(q)}`, hits: rows.map((r) => ({ href: `/admin/inventory/materials/${r.id}`, title: r.name, sub: r.kind })) });
    }
  }
  const found = groups.filter((g) => g.hits.length);
  // One exact hit (e.g. an order number) opens directly.
  if (req.query.go === '1' && found.length === 1 && found[0].hits.length === 1) return res.redirect(found[0].hits[0].href);
  res.render('admin/search', { title: q ? `Search: ${q}` : 'Search', searchQuery: q, groups: found, searched: q.length >= 2 });
});

module.exports = router;
