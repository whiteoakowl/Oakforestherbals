'use strict';
// Invoices, the payments ledger, expenses and financial reporting.
const { get, all, run, insert, tx } = require('./db');
const settings = require('./settings');
const { token } = require('./utils');

const err = (message, status = 409) => Object.assign(new Error(message), { status });
const EXPENSE_CATEGORIES = [
  ['ingredients', 'Herbs and ingredients'], ['packaging', 'Packaging and labels'], ['shipping', 'Shipping and postage'], ['rent', 'Rent and utilities'],
  ['equipment', 'Equipment'], ['software', 'Software and subscriptions'], ['marketing', 'Marketing'], ['fees', 'Payment and bank fees'],
  ['insurance', 'Insurance'], ['education', 'Training and education'], ['wages', 'Wages and contractors'], ['other', 'Other'],
];

async function nextNumber() {
  const max = (await get('SELECT MAX(number) AS n FROM invoices')).n;
  return Math.max(Number(settings.load('invoices').next_number) || 1001, (max || 0) + 1);
}

async function recalc(invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ?', invoiceId);
  const subtotal = items.reduce((s, i) => s + Math.round(Number(i.quantity) * i.unit_price), 0);
  const taxRate = Number(settings.load('taxes').default_rate) || 0;
  const tax = Math.round(items.filter((i) => i.taxable).reduce((s, i) => s + Number(i.quantity) * i.unit_price, 0) * (taxRate / 100));
  const total = subtotal + tax;
  const paid = Number((await get('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ?', invoiceId)).s);
  let status = inv.status;
  if (status !== 'void' && status !== 'draft') status = paid >= total && total > 0 ? 'paid' : paid > 0 ? 'partial' : 'open';
  await run('UPDATE invoices SET subtotal = ?, tax_total = ?, total = ?, paid_total = ?, status = ? WHERE id = ?', subtotal, tax, total, paid, status, invoiceId);
  return { subtotal, tax, total, paid, status };
}

/** Creates an invoice. items: [{ description, quantity, unit_price, taxable }]. */
async function createInvoice({ customerId, email, name, items, dueDays, notes = '', appointmentId = null, staffId = null, issue = true, createdBy = '' }) {
  return tx(async () => {
    const due = new Date(Date.now() + (dueDays ?? Number(settings.load('invoices').due_days) ?? 14) * 86400000).toISOString().slice(0, 10);
    const id = await insert(`INSERT INTO invoices (number, token, customer_id, email, name, status, issued_on, due_on, notes, appointment_id, staff_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ${issue ? 'CURRENT_DATE' : 'NULL'}, ?, ?, ?, ?, ?)`, await nextNumber(), token(16), customerId, email || '', name || '', issue ? 'open' : 'draft',
    due, notes, appointmentId, staffId, createdBy);
    for (const [i, it] of items.entries()) {
      await run('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, taxable, position) VALUES (?, ?, ?, ?, ?, ?)', id, String(it.description).slice(0, 300), it.quantity || 1, it.unit_price, it.taxable ? 1 : 0, i);
    }
    await recalc(id);
    if (appointmentId) await run('UPDATE appointments SET invoice_id = ? WHERE id = ?', id, appointmentId);
    return id;
  });
}

async function recordPayment({ invoiceId = null, orderId = null, amount, method, reference = '', by = '', kind = 'payment' }) {
  if (!Number.isInteger(amount) || amount === 0) throw err('Enter an amount.', 422);
  return tx(async () => {
    if (invoiceId) {
      const inv = await get('SELECT * FROM invoices WHERE id = ? FOR UPDATE', invoiceId);
      if (!inv || inv.status === 'void') throw err('This invoice is void.');
      if (inv.status === 'draft') await run("UPDATE invoices SET status = 'open', issued_on = COALESCE(issued_on, CURRENT_DATE) WHERE id = ?", invoiceId);
      if (kind === 'payment' && amount > inv.total - inv.paid_total) throw err(`That's more than the ${((inv.total - inv.paid_total) / 100).toFixed(2)} still owed.`, 422);
    }
    const id = await insert('INSERT INTO payments (invoice_id, order_id, amount, method, reference, kind, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      invoiceId, orderId, kind === 'refund' ? -Math.abs(amount) : amount, String(method || '').slice(0, 60), String(reference || '').slice(0, 120), kind, by);
    if (invoiceId) await recalc(invoiceId);
    return id;
  });
}

async function loadInvoice(where, value) {
  const inv = await get(`SELECT i.*, c.first_name, c.last_name, s.name AS staff_name, a.starts_at AS appointment_at, a.type_name FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN staff s ON s.id = i.staff_id LEFT JOIN appointments a ON a.id = i.appointment_id WHERE i.${where} = ?`, value);
  if (!inv) return null;
  inv.items = await all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id', inv.id);
  inv.payments = await all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_at', inv.id);
  inv.balance = inv.total - inv.paid_total;
  return inv;
}

/* ---------- Reporting ---------- */

// Month-by-month figures for a date range (inclusive start, exclusive end), cents.
async function summary(from, to) {
  const months = await all(`WITH m AS (SELECT generate_series(date_trunc('month', ?::date), date_trunc('month', (?::date - 1)), interval '1 month')::date AS month)
    SELECT to_char(m.month, 'YYYY-MM') AS month,
      COALESCE((SELECT SUM(o.total - o.refunded_total - o.tax_total) FROM orders o WHERE o.status != 'cancelled' AND o.financial_status IN ('paid', 'partially_refunded') AND date_trunc('month', o.created_at)::date = m.month), 0) AS product_sales,
      COALESCE((SELECT SUM(oi.quantity * oi.unit_cost) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' AND o.financial_status IN ('paid', 'partially_refunded') AND date_trunc('month', o.created_at)::date = m.month), 0) AS cogs,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id IS NOT NULL AND date_trunc('month', p.received_at)::date = m.month), 0) AS services,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE date_trunc('month', e.spent_on)::date = m.month), 0) AS expenses,
      COALESCE((SELECT SUM(o.tax_total) FROM orders o WHERE o.status != 'cancelled' AND o.financial_status IN ('paid', 'partially_refunded') AND date_trunc('month', o.created_at)::date = m.month), 0) AS sales_tax,
      COALESCE((SELECT SUM(l.qty_received * l.unit_cost) FROM material_lots l WHERE l.purchase_order_item_id IS NOT NULL AND date_trunc('month', l.received_at)::date = m.month), 0) AS purchases
    FROM m ORDER BY m.month`, from, to);
  for (const r of months) {
    for (const k of ['product_sales', 'cogs', 'services', 'expenses', 'sales_tax', 'purchases']) r[k] = Math.round(Number(r[k]));
    r.revenue = r.product_sales + r.services;
    r.gross = r.revenue - r.cogs;
    r.net = r.gross - r.expenses;
  }
  const totals = months.reduce((t, r) => { for (const k of Object.keys(r)) if (k !== 'month') t[k] = (t[k] || 0) + r[k]; return t; }, {});
  const outstanding = await all("SELECT i.*, c.first_name, c.last_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('open', 'partial') ORDER BY i.due_on");
  const byCategory = await all('SELECT category, SUM(amount) AS total FROM expenses WHERE spent_on >= ? AND spent_on < ? GROUP BY category ORDER BY total DESC', from, to);
  const byPractitioner = await all(`SELECT s.name, COUNT(DISTINCT i.id) AS invoices, SUM(p.amount) AS paid FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN staff s ON s.id = i.staff_id
    WHERE p.received_at >= ? AND p.received_at < ? GROUP BY s.name ORDER BY paid DESC`, from, to);
  const refunds = Math.abs(Number((await get("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE kind = 'refund' AND received_at >= ? AND received_at < ?", from, to)).s));
  return { months, totals, outstanding, byCategory: byCategory.map((r) => ({ ...r, total: Number(r.total) })), byPractitioner: byPractitioner.map((r) => ({ ...r, paid: Number(r.paid) })), refunds };
}

module.exports = { EXPENSE_CATEGORIES, nextNumber, recalc, createInvoice, recordPayment, loadInvoice, summary };
