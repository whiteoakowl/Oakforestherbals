'use strict';
// The admin home "command centre": widgets drawn from every module, shown only when the staff
// member's role allows it, and hideable per person. Clinic widgets show counts, never names.
const { get, all, run } = require('./db');
const settings = require('./settings');
const scheduling = require('./scheduling');
const inventory = require('./inventory');
const comms = require('./comms');

const WIDGETS = [
  ['notifications', 'Notifications', () => true],
  ['appointments', 'Upcoming appointments', (can) => can('scheduling.manage') || can('scheduling.own')],
  ['clinic', 'Clinic', (can) => can('clinic.patients.view_all') || can('clinic.patients.view_assigned')],
  ['inventory', 'Inventory', (can) => can('inventory.manage')],
  ['production', 'Production', (can) => can('production.manage')],
  ['finance', 'Finance', (can) => can('finance.view') || can('invoices.manage')],
  ['revenue', 'Revenue by month', (can) => can('finance.view')],
  ['customers', 'Recent customer activity', (can) => can('customers.view')],
];

async function hidden(staffId) {
  const row = await get("SELECT value FROM staff_preferences WHERE staff_id = ? AND key = 'dashboard_hidden'", staffId);
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}

async function setHidden(staffId, keys) {
  await run(`INSERT INTO staff_preferences (staff_id, key, value) VALUES (?, 'dashboard_hidden', ?) ON CONFLICT (staff_id, key) DO UPDATE SET value = EXCLUDED.value`, staffId, JSON.stringify(keys));
}

async function build(staff, can) {
  const hide = await hidden(staff.id);
  const available = WIDGETS.filter(([, , allowed]) => allowed(can));
  const shown = available.filter(([k]) => !hide.includes(k)).map(([k]) => k);
  const data = {};
  const tz = settings.load('booking').timezone;
  if (shown.includes('notifications')) data.notifications = (await comms.forStaff(staff, { unreadOnly: true, limit: 6 }));
  if (shown.includes('appointments')) {
    const own = !can('scheduling.manage');
    data.appointments = (await all(`SELECT a.id, a.starts_at, a.type_name, a.status, s.name AS staff_name FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
      WHERE a.status IN ('booked', 'confirmed') AND a.starts_at >= now() ${own ? 'AND a.staff_id = ?' : ''} ORDER BY a.starts_at LIMIT 6`, ...(own ? [staff.id] : [])))
      .map((a) => ({ ...a, when: scheduling.formatWhen(a.starts_at, tz) }));
    data.todayCount = (await get(`SELECT COUNT(*) AS n FROM appointments WHERE status IN ('booked', 'confirmed') AND starts_at >= ? AND starts_at < ? ${own ? 'AND staff_id = ?' : ''}`,
      scheduling.zonedToUtc(scheduling.utcToZoned(new Date(), tz).day, '00:00', tz).toISOString(), scheduling.zonedToUtc(scheduling.addDays(scheduling.utcToZoned(new Date(), tz).day, 1), '00:00', tz).toISOString(), ...(own ? [staff.id] : []))).n;
  }
  if (shown.includes('clinic')) {
    const all_ = can('clinic.patients.view_all');
    const scope = all_ ? 'TRUE' : 'EXISTS (SELECT 1 FROM practitioner_assignments pa WHERE pa.patient_id = p.id AND pa.staff_id = ?)';
    const params = all_ ? [] : [staff.id];
    data.clinic = {
      active: (await get(`SELECT COUNT(*) AS n FROM patients p WHERE p.status = 'active' AND ${scope}`, ...params)).n,
      newPatients: (await get(`SELECT COUNT(*) AS n FROM patients p WHERE p.created_at > now() - interval '30 days' AND ${scope}`, ...params)).n,
      formsWaiting: (await get(`SELECT COUNT(*) AS n FROM form_assignments a JOIN patients p ON p.id = a.patient_id WHERE a.status = 'submitted' AND ${scope}`, ...params)).n,
      unread: (await get(`SELECT COUNT(*) AS n FROM messages m JOIN message_threads t ON t.id = m.thread_id JOIN patients p ON p.id = t.patient_id WHERE m.sender_type = 'patient' AND m.read_by_staff_at IS NULL AND ${scope}`, ...params)).n,
      drafts: (await get('SELECT COUNT(*) AS n FROM clinical_notes WHERE author_id = ? AND signed_at IS NULL', staff.id)).n,
      practitioners: (await get("SELECT COUNT(DISTINCT staff_id) AS n FROM practitioner_assignments")).n,
    };
  }
  if (shown.includes('inventory')) {
    const s = await inventory.stockSummary();
    data.inventory = { value: s.totalValue, finished: await inventory.finishedGoodsValue(), low: s.rows.filter((r) => r.low).slice(0, 5), expiring: s.rows.filter((r) => r.expiring || r.expired).slice(0, 5), warnDays: s.warnDays };
  }
  if (shown.includes('production')) {
    data.production = await all(`SELECT b.id, b.code, b.status, b.planned_for, COALESCE(f.name, p.title) AS name FROM production_batches b LEFT JOIN formulas f ON f.id = b.formula_id
      LEFT JOIN variants v ON v.id = b.variant_id LEFT JOIN products p ON p.id = v.product_id WHERE b.status IN ('planned', 'in_progress', 'awaiting_qc', 'completed') ORDER BY b.planned_for NULLS LAST, b.id LIMIT 6`);
  }
  if (shown.includes('finance')) {
    data.finance = {
      outstanding: await get("SELECT COUNT(*) AS n, COALESCE(SUM(total - paid_total), 0) AS amount FROM invoices WHERE status IN ('open', 'partial')"),
      overdue: (await get("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('open', 'partial') AND due_on < CURRENT_DATE")).n,
      pendingOrders: await get("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE financial_status = 'pending' AND status != 'cancelled'"),
    };
  }
  if (shown.includes('revenue')) {
    const year = new Date().getUTCFullYear();
    data.revenue = (await require('./billing').summary(`${year}-01-01`, `${year + 1}-01-01`)).months;
  }
  if (shown.includes('customers')) {
    data.customers = await all(`SELECT c.id, c.first_name, c.last_name, c.email, c.created_at, (SELECT MAX(created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order
      FROM customers c ORDER BY GREATEST(c.created_at, COALESCE((SELECT MAX(created_at) FROM orders o WHERE o.customer_id = c.id), c.created_at)) DESC LIMIT 6`);
  }
  return { available: available.map(([k, label]) => [k, label]), shown, data, hidden: hide };
}

module.exports = { WIDGETS, build, setHidden, hidden };
