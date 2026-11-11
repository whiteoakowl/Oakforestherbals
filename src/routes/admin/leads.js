'use strict';
// The leads pipeline: a board of enquiries by stage, each with notes, a follow-up date and an owner;
// convert one into a customer (and a clinic client) when they decide to go ahead.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const leads = require('../../leads');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt } = require('../../utils');

const router = express.Router();
const text = (v, max = 5000) => String(v || '').trim().slice(0, max);
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

router.get('/', async (req, res) => {
  const mine = req.query.mine === '1';
  const q = text(req.query.q, 100);
  const columns = await leads.board({ ownerId: mine ? res.locals.staff.id : null, q });
  const people = await all('SELECT id, name FROM staff ORDER BY name');
  const today = new Date().toISOString().slice(0, 10);
  res.render('admin/leads/index', { title: 'Leads', columns, mine, q, people, today, SOURCES: leads.SOURCES, STAGES: leads.STAGES });
});

router.post('/', async (req, res) => {
  const name = text(req.body.name, 200);
  if (!name) { flash(req, 'error', 'Enter a name.'); return res.redirect('/admin/leads'); }
  const id = await insert('INSERT INTO leads (name, email, phone, source, interest, next_follow_up, owner_id, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM customers WHERE email = ?))',
    name, text(req.body.email, 200).toLowerCase(), text(req.body.phone, 60), text(req.body.source, 60) || 'Other', text(req.body.interest), day(req.body.next_follow_up), res.locals.staff.id, text(req.body.email, 200).toLowerCase());
  await audit.record(req, 'lead.created', { entityType: 'lead', entityId: id });
  res.redirect(`/admin/leads/${id}`);
});

async function leadParam(req, res, next) {
  const lead = await get('SELECT l.*, s.name AS owner_name FROM leads l LEFT JOIN staff s ON s.id = l.owner_id WHERE l.id = ?', toInt(req.params.id));
  if (!lead) return res.status(404).render('admin/error', { title: 'Not found', message: 'This lead does not exist.' });
  req.lead = lead;
  next();
}

router.get('/:id', leadParam, async (req, res) => {
  const people = await all('SELECT id, name FROM staff ORDER BY name');
  const customer = req.lead.customer_id ? await get('SELECT id, email, first_name, last_name FROM customers WHERE id = ?', req.lead.customer_id) : null;
  const patient = customer ? await get('SELECT id FROM patients WHERE customer_id = ?', customer.id) : null;
  res.render('admin/leads/show', { title: req.lead.name, lead: req.lead, people, customer, patient, STAGES: leads.STAGES, SOURCES: leads.SOURCES });
});

router.post('/:id', leadParam, async (req, res) => {
  const l = req.lead;
  const stage = leads.STAGES.some(([k]) => k === req.body.stage) ? req.body.stage : l.stage;
  const addNote = text(req.body.add_note);
  const notes = addNote ? `${l.notes ? `${l.notes}\n\n` : ''}[${new Date().toISOString().slice(0, 10)}, ${res.locals.staff.name}] ${addNote}`.slice(0, 20000) : l.notes;
  const owner = req.body.owner_id !== undefined ? (toInt(req.body.owner_id) || null) : l.owner_id;
  await run(`UPDATE leads SET stage = ?, notes = ?, next_follow_up = ?, owner_id = ?, lost_reason = ?, name = ?, email = ?, phone = ?, source = ?, updated_at = now() WHERE id = ?`,
    stage, notes, req.body.next_follow_up !== undefined ? day(req.body.next_follow_up) : l.next_follow_up, owner, stage === 'lost' ? text(req.body.lost_reason, 300) || l.lost_reason : '',
    text(req.body.name, 200) || l.name, req.body.email !== undefined ? text(req.body.email, 200).toLowerCase() : l.email, req.body.phone !== undefined ? text(req.body.phone, 60) : l.phone,
    req.body.source !== undefined ? text(req.body.source, 60) : l.source, l.id);
  if (stage !== l.stage) await audit.record(req, 'lead.stage_changed', { entityType: 'lead', entityId: l.id, details: { from: l.stage, to: stage } });
  const back = String(req.body.back || '');
  res.redirect(back === 'board' ? '/admin/leads' : `/admin/leads/${l.id}`);
});

// Makes (or links) the customer record; optionally continues to opening a clinic record.
router.post('/:id/convert', leadParam, async (req, res) => {
  const l = req.lead;
  if (!l.email.includes('@')) { flash(req, 'error', 'Add an email address first.'); return res.redirect(`/admin/leads/${l.id}`); }
  let customer = await get('SELECT id FROM customers WHERE email = ?', l.email);
  if (!customer) {
    const [first, ...rest] = l.name.split(' ');
    customer = { id: await insert('INSERT INTO customers (email, first_name, last_name, phone) VALUES (?, ?, ?, ?)', l.email, first || '', rest.join(' '), l.phone) };
  }
  await run("UPDATE leads SET stage = 'client', customer_id = ?, next_follow_up = NULL, updated_at = now() WHERE id = ?", customer.id, l.id);
  await audit.record(req, 'lead.converted', { entityType: 'lead', entityId: l.id, details: { customer: customer.id } });
  if (req.body.clinic === '1' && res.locals.can('clinic.records.manage')) return res.redirect(`/admin/clinic/patients/new?email=${encodeURIComponent(l.email)}`);
  flash(req, 'success', `${l.name} is now a customer.`);
  res.redirect(res.locals.can('customers.view') ? `/admin/customers/${customer.id}` : `/admin/leads/${l.id}`);
});

module.exports = router;
