'use strict';
// Finance: invoices (with payments), expenses, and reports with CSV exports for accounting.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const billing = require('../../billing');
const mailer = require('../../mailer');
const audit = require('../../audit');
const { flash, requirePermission } = require('../../middleware');
const { toInt, parseMoney, asList, csvRow, centsToInput } = require('../../utils');

const invoices = express.Router();
const finance = express.Router();
const text = (v, max = 2000) => String(v || '').trim().slice(0, max);
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const fail = (req, res, msg, to) => { flash(req, 'error', msg); return res.redirect(to); };
const METHODS = ['Card', 'Cash', 'Bank transfer', 'Check', 'Stripe', 'Other'];

for (const r of [invoices, finance]) r.use((req, res, next) => { Object.assign(res.locals, { ymd, METHODS, EXPENSE_CATEGORIES: billing.EXPENSE_CATEGORIES }); next(); });

/* ---------- Invoices ---------- */

invoices.get('/', async (req, res) => {
  const status = ['draft', 'open', 'partial', 'paid', 'void'].includes(req.query.status) ? req.query.status : '';
  const rows = await all(`SELECT i.*, c.first_name, c.last_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id ${status ? 'WHERE i.status = ?' : ''} ORDER BY i.id DESC LIMIT 200`, ...(status ? [status] : []));
  res.render('admin/invoices/index', { title: 'Invoices', rows, status });
});

invoices.get('/new', async (req, res) => {
  const customer = toInt(req.query.customer) ? await get('SELECT id, email, first_name, last_name FROM customers WHERE id = ?', toInt(req.query.customer)) : null;
  res.render('admin/invoices/new', { title: 'New invoice', customer });
});

invoices.post('/new', async (req, res) => {
  const email = text(req.body.email, 200).toLowerCase();
  let customer = await get('SELECT * FROM customers WHERE email = ?', email);
  if (!email.includes('@')) return fail(req, res, 'Enter the client’s email.', '/admin/invoices/new');
  if (!customer) customer = { id: await insert('INSERT INTO customers (email, first_name, last_name) VALUES (?, ?, ?)', email, text(req.body.first_name, 100), text(req.body.last_name, 100)), first_name: text(req.body.first_name, 100), last_name: text(req.body.last_name, 100) };
  const items = asList(req.body.items).map((i) => ({ description: text(i && i.description, 300), quantity: Number(i && i.quantity) || 1, unit_price: parseMoney(i && i.unit_price), taxable: i && i.taxable === '1' }))
    .filter((i) => i.description && i.unit_price !== null);
  if (!items.length) return fail(req, res, 'Add at least one line with a description and price.', '/admin/invoices/new');
  const id = await billing.createInvoice({ customerId: customer.id, email, name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), items, dueDays: toInt(req.body.due_days, 14), notes: text(req.body.notes), issue: req.body.draft !== '1', createdBy: res.locals.staff.name });
  await audit.record(req, 'invoice.created', { entityType: 'invoice', entityId: id });
  res.redirect(`/admin/invoices/${id}`);
});

async function invParam(req, res, next) {
  const inv = await billing.loadInvoice('id', toInt(req.params.id));
  if (!inv) return res.status(404).render('admin/error', { title: 'Not found', message: 'This invoice does not exist.' });
  req.inv = inv;
  next();
}

invoices.get('/:id', invParam, (req, res) => res.render('admin/invoices/show', { title: `Invoice #${req.inv.number}`, inv: req.inv, base: process.env.BASE_URL || process.env.URL || '' }));
invoices.get('/:id/print', invParam, (req, res) => res.render('store/invoice', { title: `Invoice #${req.inv.number}`, inv: req.inv, printOnly: true, canPay: false }));

invoices.post('/:id/payments', invParam, async (req, res) => {
  const back = `/admin/invoices/${req.inv.id}`;
  try {
    await billing.recordPayment({ invoiceId: req.inv.id, amount: parseMoney(req.body.amount), method: METHODS.includes(req.body.method) ? req.body.method : 'Other', reference: text(req.body.reference, 120), by: res.locals.staff.name, kind: req.body.kind === 'refund' ? 'refund' : 'payment' });
    await audit.record(req, 'invoice.payment_recorded', { entityType: 'invoice', entityId: req.inv.id });
    flash(req, 'success', req.body.kind === 'refund' ? 'Refund recorded.' : 'Payment recorded.');
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
  }
  res.redirect(back);
});

invoices.post('/:id/status', invParam, async (req, res) => {
  const inv = req.inv;
  if (req.body.status === 'void' && inv.paid_total === 0) await run("UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
  else if (req.body.status === 'open' && inv.status === 'draft') { await run("UPDATE invoices SET status = 'open', issued_on = CURRENT_DATE WHERE id = ?", inv.id); await billing.recalc(inv.id); }
  else flash(req, 'error', inv.paid_total ? 'Refund the payments before voiding.' : 'That change isn’t possible.');
  await audit.record(req, `invoice.${req.body.status}`, { entityType: 'invoice', entityId: inv.id });
  res.redirect(`/admin/invoices/${inv.id}`);
});

invoices.post('/:id/send', invParam, async (req, res) => {
  const inv = req.inv;
  if (!inv.email) return fail(req, res, 'This invoice has no email address.', `/admin/invoices/${inv.id}`);
  const base = process.env.BASE_URL || process.env.URL || '';
  await mailer.sendRaw(inv.email, `Invoice #${inv.number} from ${res.locals.store.name}`, `<p>Your invoice #${inv.number} for ${res.locals.money(inv.total)} is ready.${inv.due_on ? ` It's due on ${ymd(inv.due_on)}.` : ''}</p><p><a href="${base}/invoices/${inv.token}">View${inv.balance > 0 ? ' and pay' : ''} your invoice</a></p>`);
  flash(req, 'success', `Invoice emailed to ${inv.email}.`);
  res.redirect(`/admin/invoices/${inv.id}`);
});

/* ---------- Finance reports ---------- */

function range(q) {
  const now = new Date();
  const year = toInt(q.year, now.getUTCFullYear());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : `${year}-01-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : `${year + 1}-01-01`;
  return { from, to, year };
}

finance.get('/', requirePermission('finance.view'), async (req, res) => {
  const r = range(req.query);
  res.render('admin/finance/index', { title: 'Financials', ...r, ...(await billing.summary(r.from, r.to)) });
});

finance.get('/expenses', requirePermission('finance.view', 'expenses.manage'), async (req, res) => {
  const r = range(req.query);
  const rows = await all('SELECT * FROM expenses WHERE spent_on >= ? AND spent_on < ? ORDER BY spent_on DESC, id DESC', r.from, r.to);
  res.render('admin/finance/expenses', { title: 'Expenses', rows, ...r });
});

finance.post('/expenses', requirePermission('expenses.manage'), async (req, res) => {
  const amount = parseMoney(req.body.amount);
  if (amount === null || amount < 0 || !text(req.body.description)) return fail(req, res, 'Enter a description and amount.', '/admin/finance/expenses');
  await insert('INSERT INTO expenses (spent_on, category, vendor, description, amount, tax, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    /^\d{4}-\d{2}-\d{2}$/.test(req.body.spent_on || '') ? req.body.spent_on : new Date().toISOString().slice(0, 10),
    billing.EXPENSE_CATEGORIES.some(([k]) => k === req.body.category) ? req.body.category : 'other', text(req.body.vendor, 200), text(req.body.description, 500), amount, parseMoney(req.body.tax) || 0, res.locals.staff.name);
  flash(req, 'success', 'Expense recorded.');
  res.redirect('/admin/finance/expenses');
});

finance.post('/expenses/:id/delete', requirePermission('expenses.manage'), async (req, res) => {
  await run('DELETE FROM expenses WHERE id = ?', toInt(req.params.id));
  await audit.record(req, 'expense.deleted', { entityType: 'expense', entityId: toInt(req.params.id) });
  res.redirect('/admin/finance/expenses');
});

finance.get('/export/:kind.csv', requirePermission('finance.view'), async (req, res, next) => {
  const r = range(req.query);
  let lines;
  if (req.params.kind === 'summary') {
    const s = await billing.summary(r.from, r.to);
    lines = [csvRow(['Month', 'Product sales (net of refunds, excl. tax)', 'Services', 'Revenue', 'Cost of goods', 'Gross profit', 'Expenses', 'Net', 'Sales tax collected', 'Inventory purchases'])];
    for (const m of s.months) lines.push(csvRow([m.month, centsToInput(m.product_sales), centsToInput(m.services), centsToInput(m.revenue), centsToInput(m.cogs), centsToInput(m.gross), centsToInput(m.expenses), centsToInput(m.net), centsToInput(m.sales_tax), centsToInput(m.purchases)]));
  } else if (req.params.kind === 'payments') {
    const rows = await all(`SELECT p.*, o.number AS order_number, i.number AS invoice_number FROM payments p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.received_at >= ? AND p.received_at < ? ORDER BY p.received_at`, r.from, r.to);
    lines = [csvRow(['Date', 'Type', 'Order', 'Invoice', 'Amount', 'Method', 'Reference', 'Recorded by'])];
    for (const p of rows) lines.push(csvRow([new Date(p.received_at).toISOString().slice(0, 10), p.kind, p.order_number || '', p.invoice_number || '', centsToInput(p.amount), p.method, p.reference, p.recorded_by]));
  } else if (req.params.kind === 'expenses') {
    const rows = await all('SELECT * FROM expenses WHERE spent_on >= ? AND spent_on < ? ORDER BY spent_on', r.from, r.to);
    lines = [csvRow(['Date', 'Category', 'Vendor', 'Description', 'Amount', 'Tax'])];
    for (const e of rows) lines.push(csvRow([ymd(e.spent_on), e.category, e.vendor, e.description, centsToInput(e.amount), centsToInput(e.tax)]));
  } else if (req.params.kind === 'invoices') {
    const rows = await all('SELECT * FROM invoices WHERE created_at >= ? AND created_at < ? ORDER BY number', r.from, r.to);
    lines = [csvRow(['Number', 'Issued', 'Due', 'Client', 'Email', 'Status', 'Subtotal', 'Tax', 'Total', 'Paid', 'Balance'])];
    for (const i of rows) lines.push(csvRow([i.number, ymd(i.issued_on), ymd(i.due_on), i.name, i.email, i.status, centsToInput(i.subtotal), centsToInput(i.tax_total), centsToInput(i.total), centsToInput(i.paid_total), centsToInput(i.total - i.paid_total)]));
  } else return next();
  res.attachment(`${req.params.kind}-${r.from}-to-${r.to}.csv`).type('text/csv').send(lines.join('\n'));
});

module.exports = { invoices, finance };
