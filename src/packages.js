'use strict';
// Session packages and memberships: a client prepays for a number of sessions (optionally only for
// certain appointment types, and within so many days). Booking uses a session instead of charging;
// cancelling gives it back. A package bought on an invoice starts once that invoice is paid.
const { get, all, run, insert, tx } = require('./db');

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const typesOf = (p) => { try { return JSON.parse(p.type_ids || '[]').map(Number); } catch { return []; } };
const covers = (p, typeId) => { const t = typesOf(p); return !t.length || t.includes(Number(typeId)); };

async function expireOld() {
  await run("UPDATE client_packages SET status = 'expired' WHERE status = 'active' AND expires_on IS NOT NULL AND expires_on < CURRENT_DATE");
}

// Active packages this client could use for this type, soonest-expiring first.
async function usableFor(customerId, typeId) {
  await expireOld();
  const rows = await all("SELECT * FROM client_packages WHERE customer_id = ? AND status = 'active' AND sessions_used < sessions_total ORDER BY expires_on NULLS LAST, id", customerId);
  return rows.filter((p) => covers(p, typeId));
}

const forCustomer = async (customerId) => { await expireOld(); return all('SELECT cp.*, i.token AS invoice_token, i.number AS invoice_number FROM client_packages cp LEFT JOIN invoices i ON i.id = cp.invoice_id WHERE cp.customer_id = ? ORDER BY cp.id DESC', customerId); };

async function activate(clientPackageId) {
  const p = await get('SELECT * FROM client_packages WHERE id = ?', clientPackageId);
  if (!p || p.status !== 'pending') return;
  await run("UPDATE client_packages SET status = 'active', expires_on = ? WHERE id = ?", p.valid_days ? ymd(Date.now() + p.valid_days * 86400000) : null, p.id);
}

// Sells a package: an invoice for it, and the package waiting for payment (or active now if free/paid).
async function sell({ customer, packageId, by, paidNow = false, method = 'Other' }) {
  const pkg = await get('SELECT * FROM service_packages WHERE id = ? AND active = 1', packageId);
  if (!pkg) throw Object.assign(new Error('That package isn’t available.'), { status: 400 });
  return tx(async () => {
    const billing = require('./billing');
    let invoiceId = null;
    if (pkg.price > 0) {
      invoiceId = await billing.createInvoice({ customerId: customer.id, email: customer.email, name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), items: [{ description: `${pkg.name} (${pkg.sessions} sessions)`, quantity: 1, unit_price: pkg.price }], createdBy: by });
    }
    const id = await insert(`INSERT INTO client_packages (customer_id, package_id, name, type_ids, sessions_total, valid_days, invoice_id, sold_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      customer.id, pkg.id, pkg.name, pkg.type_ids, pkg.sessions, pkg.valid_days, invoiceId, by);
    if (!invoiceId) await activate(id);
    else if (paidNow) {
      const inv = await get('SELECT total FROM invoices WHERE id = ?', invoiceId);
      await billing.recordPayment({ invoiceId, amount: inv.total, method, reference: '', by, kind: 'payment' });
    }
    return { id, invoiceId };
  });
}

// Uses one session for an appointment. Returns true when it did.
async function use(clientPackageId, appointmentId, customerId, typeId) {
  return tx(async () => {
    const p = await get("SELECT * FROM client_packages WHERE id = ? AND customer_id = ? AND status = 'active' FOR UPDATE", clientPackageId, customerId);
    if (!p || p.sessions_used >= p.sessions_total || !covers(p, typeId) || (p.expires_on && ymd(p.expires_on) < ymd(Date.now()))) return false;
    await run('INSERT INTO package_uses (client_package_id, appointment_id) VALUES (?, ?)', p.id, appointmentId);
    await run(`UPDATE client_packages SET sessions_used = sessions_used + 1, status = CASE WHEN sessions_used + 1 >= sessions_total THEN 'used' ELSE status END WHERE id = ?`, p.id);
    await run('UPDATE appointments SET price = 0, deposit = 0 WHERE id = ?', appointmentId);
    return true;
  });
}

// A cancelled appointment gives its session back.
async function release(appointmentId) {
  await tx(async () => {
    const u = await get('SELECT * FROM package_uses WHERE appointment_id = ?', appointmentId);
    if (!u) return;
    await run('DELETE FROM package_uses WHERE id = ?', u.id);
    await run(`UPDATE client_packages SET sessions_used = sessions_used - 1, status = CASE WHEN status = 'used' THEN 'active' ELSE status END WHERE id = ?`, u.client_package_id);
  });
}

const usedFor = (appointmentId) => get('SELECT cp.* FROM package_uses u JOIN client_packages cp ON cp.id = u.client_package_id WHERE u.appointment_id = ?', appointmentId);

module.exports = { typesOf, covers, usableFor, forCustomer, activate, sell, use, release, usedFor };
