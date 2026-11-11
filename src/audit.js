'use strict';
// Append-only audit trail (audit_logs). Record who did what to which record — never secrets,
// passwords, payment details or clinical content. Failures to write are logged, not thrown,
// so auditing can never block the action itself.
const { run } = require('./db');

const SECRET_KEY = /pass|secret|token|key|card|cvv/i;

function scrub(details) {
  const out = {};
  for (const [k, v] of Object.entries(details || {})) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  return out;
}

async function record(req, action, { entityType = '', entityId = '', details = {}, actor } = {}) {
  const staff = req && req.res && req.res.locals.staff;
  const who = actor || (staff ? { type: 'staff', id: staff.id, name: staff.name } : { type: 'system', id: null, name: '' });
  try {
    await run(`INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, who.type, who.id, who.name || '', action, entityType, String(entityId || ''),
    JSON.stringify(scrub(details)), (req && req.ip) || '');
  } catch (err) {
    console.error('audit log write failed', action, err.message);
  }
}

module.exports = { record, scrub };
