'use strict';
const express = require('express');
const { get, all, run } = require('../../db');
const orders = require('../../orders');
const pricing = require('../../pricing');
const { intArray } = require('../../catalog');
const { COUNTRIES } = require('../../countries');
const { flash } = require('../../middleware');
const { toInt, parseMoney, paginate, csvRow, parseTags, centsToInput, asBool, asList, idFromKey } = require('../../utils');

const router = express.Router();

const TABS = {
  all: "status != 'archived'",
  unfulfilled: "status = 'open' AND fulfillment_status != 'fulfilled'",
  unpaid: "status = 'open' AND financial_status = 'pending'",
  open: "status = 'open'",
  archived: "status = 'archived'",
  cancelled: "status = 'cancelled'",
};

function filters(req) {
  const tab = TABS[req.query.tab] ? req.query.tab : 'all';
  const where = [TABS[tab]];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push("(email ILIKE ? OR CAST(number AS TEXT) ILIKE ? OR shipping_address ILIKE ? OR tags ILIKE ?)");
    const like = `%${q.replace(/^#/, '')}%`;
    params.push(like, like, like, like);
  }
  if (req.query.financial) { where.push('financial_status = ?'); params.push(req.query.financial); }
  if (req.query.fulfillment) { where.push('fulfillment_status = ?'); params.push(req.query.fulfillment); }
  return { tab, q, where: where.join(' AND '), params };
}

router.get('/', async (req, res) => {
  const f = filters(req);
  const total = (await get(`SELECT COUNT(*) AS n FROM orders WHERE ${f.where}`, ...f.params)).n;
  const pager = paginate(total, req.query.page, 25);
  const list = (await all(`SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o WHERE ${f.where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...f.params, pager.perPage, pager.offset))
    .map((o) => ({ ...o, name: orders.orderName(o), shipping_address: JSON.parse(o.shipping_address || '{}') }));
  res.render('admin/orders/index', { title: 'Orders', orders: list, pager, tab: f.tab, q: f.q, TABS: Object.keys(TABS) });
});

router.get('/export.csv', async (req, res) => {
  const f = filters(req);
  const lines = [csvRow(['Name', 'Email', 'Created at', 'Financial status', 'Fulfillment status', 'Status', 'Subtotal', 'Discount code',
    'Discount amount', 'Shipping', 'Taxes', 'Total', 'Refunded', 'Shipping method', 'Payment method', 'Lineitem quantity',
    'Lineitem name', 'Lineitem price', 'Lineitem sku', 'Shipping name', 'Shipping address1', 'Shipping city', 'Shipping province',
    'Shipping zip', 'Shipping country', 'Note'])];
  const list = await all(`SELECT * FROM orders WHERE ${f.where} ORDER BY id`, ...f.params);
  const allItems = list.length ? await all('SELECT * FROM order_items WHERE order_id = ANY(?::int[]) ORDER BY id', intArray(list.map((o) => o.id))) : [];
  for (const o of list) {
    const a = JSON.parse(o.shipping_address || '{}');
    const items = allItems.filter((i) => i.order_id === o.id);
    items.forEach((i, idx) => {
      const head = idx === 0;
      lines.push(csvRow([orders.orderName(o), o.email, new Date(o.created_at).toISOString(), head ? o.financial_status : '', head ? o.fulfillment_status : '',
        head ? o.status : '', head ? centsToInput(o.subtotal) : '', head ? o.discount_code : '', head ? centsToInput(o.discount_total) : '',
        head ? centsToInput(o.shipping_total) : '', head ? centsToInput(o.tax_total) : '', head ? centsToInput(o.total) : '',
        head ? centsToInput(o.refunded_total) : '', head ? o.shipping_method : '', head ? o.payment_method : '', i.quantity,
        `${i.title}${i.variant_title ? ` - ${i.variant_title}` : ''}`, centsToInput(i.price), i.sku,
        head ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '', head ? a.address1 : '', head ? a.city : '',
        head ? a.province : '', head ? a.zip : '', head ? a.country : '', head ? o.note : '']));
    });
  }
  res.attachment('orders.csv').type('text/csv').send(lines.join('\n'));
});

/* ---------- Manual (draft) orders created by staff ---------- */

router.get('/new', async (req, res) => {
  const variants = await all(`SELECT v.id, v.title, v.price, v.inventory_qty, v.track_inventory, p.title AS product_title
    FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' ORDER BY lower(p.title), v.position`);
  res.render('admin/orders/new', { title: 'Create order', variants, COUNTRIES });
});

router.post('/new', async (req, res) => {
  const lines = asList(req.body.lines).filter((l) => l && toInt(l.variant_id) && toInt(l.quantity) > 0);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!lines.length || !email.includes('@')) {
    flash(req, 'error', 'Add at least one product and a customer email.');
    return res.redirect('/admin/orders/new');
  }
  const cart = await pricing.buildCart(lines.map((l) => ({ variant_id: toInt(l.variant_id), quantity: toInt(l.quantity) })));
  const fields = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];
  const address = Object.fromEntries(fields.map((f) => [f, String(req.body[f] || '').trim()]));
  const shipping = { name: String(req.body.shipping_name || 'Custom shipping'), price: parseMoney(req.body.shipping_price) || 0 };
  const discount = req.body.discount_code ? (await pricing.validateDiscount(req.body.discount_code, cart, email)).discount || null : null;
  const totals = await pricing.computeTotals(cart, { discount, shipping, address });
  let order;
  try {
    order = await orders.createOrder({
      cart, totals, discount, shipping,
      contact: { email, phone: address.phone, accepts_marketing: false },
      shippingAddress: address, billingAddress: address,
      payment: { name: req.body.mark_paid ? 'Manual (paid)' : 'Manual (invoice)' },
      note: String(req.body.note || ''),
    });
  } catch (err) {
    if (err.status !== 409) throw err;
    flash(req, 'error', err.message);
    return res.redirect('/admin/orders/new');
  }
  await orders.addEvent(order.id, `Order created by staff.`, author(res));
  if (req.body.mark_paid) await orders.markPaid(order.id, { author: author(res) });
  flash(req, 'success', `Order ${order.name} created.`);
  res.redirect(back(order.id));
});

router.get('/:id', async (req, res, next) => {
  const order = await orders.orderById(toInt(req.params.id));
  if (!order) return next();
  const customerStats = order.customer_id
    ? await get("SELECT COUNT(*) AS orders, COALESCE(SUM(total - refunded_total), 0) AS spent FROM orders WHERE customer_id = ? AND status != 'cancelled'", order.customer_id)
    : null;
  const prevOrder = await get('SELECT id FROM orders WHERE id < ? ORDER BY id DESC LIMIT 1', order.id);
  const nextOrder = await get('SELECT id FROM orders WHERE id > ? ORDER BY id LIMIT 1', order.id);
  res.render('admin/orders/show', { title: `Order ${order.name}`, order, customerStats, prevOrder, nextOrder });
});

router.get('/:id/packing-slip', async (req, res, next) => {
  const order = await orders.orderById(toInt(req.params.id));
  if (!order) return next();
  res.render('admin/orders/packing-slip', { title: `Packing slip ${order.name}`, order, bare: true });
});

const author = (res) => res.locals.staff.name;
const back = (id) => `/admin/orders/${id}`;

router.post('/:id/paid', async (req, res) => {
  await orders.markPaid(toInt(req.params.id), { ref: String(req.body.ref || ''), author: author(res) });
  flash(req, 'success', 'Order marked as paid.');
  res.redirect(back(req.params.id));
});

router.post('/:id/fulfill', async (req, res) => {
  const qty = req.body.qty || {};
  const items = Object.entries(qty).map(([key, quantity]) => ({ id: idFromKey(key), quantity: toInt(quantity) })).filter((i) => i.quantity > 0);
  if (!items.length) {
    flash(req, 'error', 'Choose at least one item to fulfill.');
    return res.redirect(back(req.params.id));
  }
  const done = await orders.fulfill(toInt(req.params.id), {
    items,
    tracking_company: String(req.body.tracking_company || ''),
    tracking_number: String(req.body.tracking_number || ''),
    tracking_url: /^https?:\/\//.test(req.body.tracking_url || '') ? req.body.tracking_url : '',
    notify: asBool(req.body.notify),
    author: author(res),
  });
  flash(req, done && done.length ? 'success' : 'error', done && done.length ? 'Items fulfilled.' : 'Nothing left to fulfill.');
  res.redirect(back(req.params.id));
});

router.post('/:id/refund', async (req, res) => {
  await orders.refund(toInt(req.params.id), {
    amount: parseMoney(req.body.amount) || 0,
    restock: asBool(req.body.restock),
    reason: String(req.body.reason || ''),
    author: author(res),
  });
  flash(req, 'success', 'Refund recorded. Remember to return the funds through your payment provider if it was not automatic.');
  res.redirect(back(req.params.id));
});

router.post('/:id/cancel', async (req, res) => {
  await orders.cancel(toInt(req.params.id), { restock: asBool(req.body.restock), reason: String(req.body.reason || ''), author: author(res) });
  flash(req, 'success', 'Order cancelled.');
  res.redirect(back(req.params.id));
});

router.post('/:id/archive', async (req, res) => {
  const id = toInt(req.params.id);
  const order = await get('SELECT status FROM orders WHERE id = ?', id);
  if (order && order.status !== 'cancelled') {
    const next = order.status === 'archived' ? 'open' : 'archived';
    await run('UPDATE orders SET status = ? WHERE id = ?', next, id);
    await orders.addEvent(id, next === 'archived' ? 'Order archived.' : 'Order unarchived.', author(res));
  }
  res.redirect(back(id));
});

router.post('/:id/comment', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (message) await orders.addEvent(toInt(req.params.id), message, author(res));
  res.redirect(back(req.params.id));
});

router.post('/:id/details', async (req, res) => {
  await run('UPDATE orders SET note = ?, tags = ? WHERE id = ?', String(req.body.note || ''), parseTags(req.body.tags).join(', '), toInt(req.params.id));
  flash(req, 'success', 'Order updated.');
  res.redirect(back(req.params.id));
});

router.post('/:id/address', async (req, res) => {
  const fields = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];
  const address = Object.fromEntries(fields.map((f) => [f, String(req.body[f] || '')]));
  await run('UPDATE orders SET shipping_address = ? WHERE id = ?', JSON.stringify(address), toInt(req.params.id));
  await orders.addEvent(toInt(req.params.id), 'Shipping address updated.', author(res));
  res.redirect(back(req.params.id));
});

module.exports = router;
