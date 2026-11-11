'use strict';
// Leads: enquiries and prospective clients, moved through stages until they become clients (or not).
const { get, all, run, insert } = require('./db');

const STAGES = [['new', 'New enquiry'], ['contacted', 'Contacted'], ['consult_booked', 'Consult booked'], ['client', 'Became a client'], ['lost', 'Not going ahead']];
const SOURCES = ['Contact form', 'Phone', 'Email', 'Referral', 'Social media', 'Event or workshop', 'Website', 'Walk-in', 'Other'];

// Adds a lead, or adds to the open lead with the same email instead of duplicating it.
async function capture({ name, email = '', phone = '', source = 'Other', interest = '', ownerId = null }) {
  const e = String(email || '').trim().toLowerCase().slice(0, 200);
  const open = e ? await get("SELECT * FROM leads WHERE email = ? AND stage NOT IN ('client', 'lost') ORDER BY id DESC LIMIT 1", e) : null;
  const stamp = new Date().toISOString().slice(0, 10);
  if (open) {
    await run('UPDATE leads SET notes = ?, updated_at = now() WHERE id = ?', `${open.notes ? `${open.notes}\n\n` : ''}[${stamp}, ${source}] ${interest}`.slice(0, 20000), open.id);
    return open.id;
  }
  const customer = e ? await get('SELECT id FROM customers WHERE email = ?', e) : null;
  const id = await insert('INSERT INTO leads (name, email, phone, source, interest, owner_id, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    String(name || e || 'Unknown').slice(0, 200), e, String(phone || '').slice(0, 60), String(source).slice(0, 60), String(interest || '').slice(0, 5000), ownerId, customer ? customer.id : null);
  await require('./comms').notifyStaff({ kind: 'lead', title: `New enquiry from ${String(name || e).slice(0, 80)}`, link: `/admin/leads/${id}`, permission: 'leads.manage' });
  return id;
}

async function board({ ownerId = null, q = '' } = {}) {
  const where = [];
  const params = [];
  if (ownerId) { where.push('l.owner_id = ?'); params.push(ownerId); }
  if (q) { where.push('(l.name ILIKE ? OR l.email ILIKE ? OR l.phone ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  // Closed leads only show for 60 days, so the board stays about current work.
  where.push("(l.stage NOT IN ('client', 'lost') OR l.updated_at > now() - interval '60 days')");
  const rows = await all(`SELECT l.*, s.name AS owner_name FROM leads l LEFT JOIN staff s ON s.id = l.owner_id WHERE ${where.join(' AND ')}
    ORDER BY l.next_follow_up NULLS LAST, l.updated_at DESC`, ...params);
  return STAGES.map(([key, label]) => ({ key, label, leads: rows.filter((r) => r.stage === key) }));
}

async function dueToday(day) {
  return all("SELECT * FROM leads WHERE stage NOT IN ('client', 'lost') AND next_follow_up IS NOT NULL AND next_follow_up <= ?", day);
}

module.exports = { STAGES, SOURCES, capture, board, dueToday };
