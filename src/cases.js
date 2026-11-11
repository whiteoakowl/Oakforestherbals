'use strict';
// Cases (episodes of care): a concern or course of treatment for one client, with who referred them,
// and everything done for it — notes, appointments, care plans and invoices — in one place.
// Callers must already have checked the staff member may see the patient.
const { get, all } = require('./db');
const vault = require('./vault');

const REFERRER_KINDS = [['doctor', 'Doctor / GP'], ['practitioner', 'Other practitioner'], ['self', 'Self-referral'], ['friend', 'Friend or family'], ['online', 'Online / search'], ['other', 'Other']];

async function forPatient(patientId) {
  return all(`SELECT c.*, r.name AS referrer_name, s.name AS practitioner_name,
      (SELECT COUNT(*) FROM clinical_notes n WHERE n.case_id = c.id) AS note_count,
      (SELECT COUNT(*) FROM appointments a WHERE a.case_id = c.id) AS appointment_count,
      (SELECT MAX(a.starts_at) FROM appointments a WHERE a.case_id = c.id AND a.status NOT IN ('cancelled')) AS last_visit
    FROM clinic_cases c LEFT JOIN referrers r ON r.id = c.referrer_id LEFT JOIN staff s ON s.id = c.practitioner_id
    WHERE c.patient_id = ? ORDER BY c.status = 'open' DESC, c.opened_on DESC, c.id DESC`, patientId);
}

const openFor = (patientId) => all("SELECT id, title FROM clinic_cases WHERE patient_id = ? AND status = 'open' ORDER BY opened_on DESC, id DESC", patientId);

async function load(patientId, caseId) {
  const c = await get(`SELECT c.*, r.name AS referrer_name, r.organisation AS referrer_org, r.email AS referrer_email, r.phone AS referrer_phone, r.address AS referrer_address,
      s.name AS practitioner_name FROM clinic_cases c LEFT JOIN referrers r ON r.id = c.referrer_id LEFT JOIN staff s ON s.id = c.practitioner_id
    WHERE c.id = ? AND c.patient_id = ?`, caseId, patientId);
  if (!c) return null;
  c.details = vault.open(c.details_enc) || {};
  c.report = vault.open(c.report_enc) || null;
  c.notes = (await all('SELECT * FROM clinical_notes WHERE case_id = ? ORDER BY visit_date DESC, id DESC', c.id)).map((n) => ({ ...n, body: vault.open(n.body_enc) || {} }));
  c.appointments = await all(`SELECT a.id, a.starts_at, a.type_name, a.status, s.name AS staff_name FROM appointments a LEFT JOIN staff s ON s.id = a.staff_id
    WHERE a.case_id = ? ORDER BY a.starts_at DESC`, c.id);
  c.plans = (await all('SELECT id, status, start_date, review_date, content_enc FROM care_plans WHERE case_id = ? ORDER BY id DESC', c.id)).map((p) => ({ ...p, content: vault.open(p.content_enc) || {} }));
  c.invoices = await all('SELECT id, number, total, paid_total, status, issued_on FROM invoices WHERE case_id = ? ORDER BY id DESC', c.id);
  return c;
}

// A case id that belongs to this patient, or null.
async function validFor(patientId, caseId) {
  const id = Number(caseId) || 0;
  if (!id) return null;
  return (await get('SELECT id FROM clinic_cases WHERE id = ? AND patient_id = ?', id, patientId)) ? id : null;
}

module.exports = { REFERRER_KINDS, forPatient, openFor, load, validFor };
