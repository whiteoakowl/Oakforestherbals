'use strict';
// Clinic → Forms: build intake, assessment and consent forms. Forms are templates (no patient
// data); answers are stored encrypted per patient in form_submissions.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const clinic2 = require('../../clinic2');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, asList } = require('../../utils');

const router = express.Router();
const KIND_KEYS = clinic2.FORM_KINDS.map(([k]) => k);

router.use((req, res, next) => {
  Object.assign(res.locals, { FIELD_TYPES: clinic2.FIELD_TYPES, FORM_KINDS: clinic2.FORM_KINDS });
  next();
});

router.get('/', async (req, res) => {
  const forms = await all(`SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submissions,
      (SELECT COUNT(*) FROM form_assignments a WHERE a.form_id = f.id AND a.status = 'assigned') AS open FROM intake_forms f ORDER BY f.status = 'archived', lower(f.name)`);
  res.render('admin/clinic/forms', { title: 'Forms', forms });
});

// Starter templates: question structure only, written by the clinic to suit their practice.
const STARTERS = {
  intake: [
    { type: 'heading', label: 'About you' }, { type: 'text', label: 'Preferred name' }, { type: 'date', label: 'Date of birth', required: true },
    { type: 'textarea', label: 'What would you like help with?', required: true }, { type: 'textarea', label: 'Current medications (name, dose, how often)' },
    { type: 'textarea', label: 'Supplements and herbs you take' }, { type: 'textarea', label: 'Allergies and sensitivities' },
    { type: 'choice', label: 'Are you pregnant or breastfeeding?', options: ['No', 'Pregnant', 'Breastfeeding', 'Prefer to discuss'], required: true },
    { type: 'file', label: 'Recent lab results (optional)' }, { type: 'signature', label: 'I confirm this information is accurate', required: true },
  ],
  consent: [{ type: 'heading', label: 'Consent' }, { type: 'choice', label: 'I consent to the clinic storing my health information for my care', options: ['Yes', 'No'], required: true }, { type: 'signature', label: 'Signature', required: true }],
  sleep: [{ type: 'scale', label: 'Sleep quality last week (0 poor – 10 excellent)', required: true }, { type: 'text', label: 'Usual bedtime' }, { type: 'text', label: 'Usual wake time' },
    { type: 'checkboxes', label: 'Which apply?', options: ['Trouble falling asleep', 'Waking in the night', 'Waking too early', 'Not refreshed on waking'] }, { type: 'textarea', label: 'Anything else about your sleep' }],
};

router.get('/new', (req, res) => res.render('admin/clinic/form-edit', { title: 'New form', form: null, fields: STARTERS[req.query.starter] || [] }));

function readForm(body) {
  return { name: String(body.name || '').trim().slice(0, 200), kind: KIND_KEYS.includes(body.kind) ? body.kind : 'custom', description: String(body.description || '').trim().slice(0, 2000), fields: clinic2.parseFields(asList(body.fields)) };
}

router.post('/new', async (req, res) => {
  const f = readForm(req.body);
  if (!f.name || !f.fields.length) { flash(req, 'error', 'Give the form a name and at least one question.'); return res.redirect('/admin/clinic/forms/new'); }
  const id = await insert('INSERT INTO intake_forms (name, kind, description, fields, created_by) VALUES (?, ?, ?, ?, ?)', f.name, f.kind, f.description, JSON.stringify(f.fields), res.locals.staff.name);
  flash(req, 'success', 'Form saved as a draft. Preview it, then publish it to assign it to patients.');
  res.redirect(`/admin/clinic/forms/${id}`);
});

async function formParam(req, res, next) {
  const form = await get('SELECT * FROM intake_forms WHERE id = ?', toInt(req.params.id));
  if (!form) return res.status(404).render('admin/error', { title: 'Not found', message: 'This form does not exist.' });
  form.fieldList = JSON.parse(form.fields);
  req.form = form;
  next();
}

router.get('/:id', formParam, (req, res) => res.render('admin/clinic/form-edit', { title: req.form.name, form: req.form, fields: req.form.fieldList }));

router.post('/:id', formParam, async (req, res) => {
  const f = readForm(req.body);
  if (!f.name || !f.fields.length) { flash(req, 'error', 'Give the form a name and at least one question.'); return res.redirect(`/admin/clinic/forms/${req.form.id}`); }
  // Changing a published form starts a new version; past answers keep the questions they were given.
  const bump = req.form.status === 'published' && JSON.stringify(f.fields) !== req.form.fields ? 1 : 0;
  const status = ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : req.form.status;
  await run('UPDATE intake_forms SET name = ?, kind = ?, description = ?, fields = ?, status = ?, version = version + ?, updated_at = now() WHERE id = ?',
    f.name, f.kind, f.description, JSON.stringify(f.fields), status, bump, req.form.id);
  await audit.record(req, 'form.updated', { entityType: 'form', entityId: req.form.id, details: { status } });
  flash(req, 'success', bump ? 'Saved as a new version. Answers already given keep their original questions.' : 'Form saved.');
  res.redirect(`/admin/clinic/forms/${req.form.id}`);
});

module.exports = router;
