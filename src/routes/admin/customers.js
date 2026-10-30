'use strict';
const express = require('express');
const { get, all, run, insert } = require('../../db');
const orders = require('../../orders');
const { flash } = require('../../middleware');
const { toInt, paginate, csvRow, parseTags, centsToInput } = require('../../utils');
const { COUNTRIES } = require('../../countries');

const router = express.Router();

const STATS = `SELECT c.*, COUNT(o.id) AS order_count, COALESCE(SUM(o.total - o.refunded_total), 0) AS spent, MAX(o.created_at) AS last_order
  FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'`;

function filters(req) {
  const where = ['1 = 1'];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q) { where.push("(c.email ILIKE ? OR (c.first_name || ' ' || c.last_name) ILIKE ? OR c.tags ILIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (req.query.segment === 'subscribers') where.push('c.accepts_marketing = 1');
  if (req.query.segment === 'accounts') where.push('c.password_hash IS NOT NULL');
  return { q, segment: req.query.segment || '', where: where.join(' AND '), params };
}

router.get('/', async (req, res) => {
  const f = filters(req);
  let having = '';
  if (f.segment === 'repeat') having = 'HAVING COUNT(o.id) > 1';
  if (f.segment === 'prospects') having = 'HAVING COUNT(o.id) = 0';
  const total = (await get(`SELECT COUNT(*) AS n FROM (${STATS} WHERE ${f.where} GROUP BY c.id ${having}) AS matching`, ...f.params)).n;
  const pager = paginate(total, req.query.page, 25);
  const customers = await all(`${STATS} WHERE ${f.where} GROUP BY c.id ${having} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...f.params, pager.perPage, pager.offset);
  res.render('admin/customers/index', { title: 'Customers', customers, pager, q: f.q, segment: f.segment });
});

router.get('/export.csv', async (req, res) => {
  const lines = [csvRow(['First Name', 'Last Name', 'Email', 'Phone', 'Accepts Marketing', 'Total Orders', 'Total Spent', 'Tags', 'Note', 'Created At'])];
  for (const c of await all(`${STATS} GROUP BY c.id ORDER BY c.id`)) {
    lines.push(csvRow([c.first_name, c.last_name, c.email, c.phone, c.accepts_marketing ? 'yes' : 'no', c.order_count, centsToInput(c.spent), c.tags, c.note, new Date(c.created_at).toISOString()]));
  }
  res.attachment('customers.csv').type('text/csv').send(lines.join('\n'));
});

router.get('/new', async (req, res) => res.render('admin/customers/edit', { title: 'New customer', customer: null, COUNTRIES }));

router.post('/new', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email.includes('@')) {
    flash(req, 'error', 'Enter a valid email.');
    return res.redirect('/admin/customers/new');
  }
  if (await get('SELECT 1 FROM customers WHERE email = ?', email)) {
    flash(req, 'error', 'A customer with this email already exists.');
    return res.redirect('/admin/customers/new');
  }
  const id = await insert('INSERT INTO customers (email, first_name, last_name, phone, accepts_marketing, tags, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    email, String(req.body.first_name || ''), String(req.body.last_name || ''), String(req.body.phone || ''),
    req.body.accepts_marketing ? 1 : 0, parseTags(req.body.tags).join(', '), String(req.body.note || ''));
  if (req.body.address1) {
    await run(`INSERT INTO addresses (customer_id, first_name, last_name, address1, address2, city, province, zip, country, phone, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, id, String(req.body.first_name || ''), String(req.body.last_name || ''),
    String(req.body.address1 || ''), String(req.body.address2 || ''), String(req.body.city || ''), String(req.body.province || ''),
    String(req.body.zip || ''), String(req.body.country || 'US'), String(req.body.phone || ''));
  }
  flash(req, 'success', 'Customer created.');
  res.redirect(`/admin/customers/${id}`);
});

router.get('/:id', async (req, res, next) => {
  const customer = await get(`${STATS} WHERE c.id = ? GROUP BY c.id`, toInt(req.params.id));
  if (!customer) return next();
  const list = (await all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', customer.id)).map((o) => ({ ...o, name: orders.orderName(o) }));
  const addresses = await all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id', customer.id);
  res.render('admin/customers/show', { title: `${customer.first_name} ${customer.last_name}`.trim() || customer.email, customer, orders: list, addresses });
});

router.post('/:id', async (req, res) => {
  const id = toInt(req.params.id);
  await run('UPDATE customers SET first_name = ?, last_name = ?, phone = ?, accepts_marketing = ?, tags = ?, note = ? WHERE id = ?',
    String(req.body.first_name || ''), String(req.body.last_name || ''), String(req.body.phone || ''),
    req.body.accepts_marketing ? 1 : 0, parseTags(req.body.tags).join(', '), String(req.body.note || ''), id);
  flash(req, 'success', 'Customer saved.');
  res.redirect(`/admin/customers/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  await run('DELETE FROM customers WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Customer deleted. Their past orders were kept.');
  res.redirect('/admin/customers');
});

module.exports = router;
