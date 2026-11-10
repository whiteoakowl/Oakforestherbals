'use strict';
// Clinic records: who may see which patient, and reading/writing the encrypted record parts.
// Access rule (enforced here, used by every clinic route):
//   - clinic.patients.view_all     -> every patient
//   - clinic.patients.view_assigned -> only patients they are assigned to
//   - neither                       -> no patient at all
// Anything a staff member can't see is answered as "not found", so record existence never leaks.
const { get, all } = require('./db');
const vault = require('./vault');

const HEALTH_CATEGORIES = [
  ['concern', 'Health concerns and goals'],
  ['condition', 'Conditions and diagnoses (as reported)'],
  ['medication', 'Current medications'],
  ['supplement', 'Supplements and herbs taken'],
  ['allergy', 'Allergies'],
  ['sensitivity', 'Sensitivities and intolerances'],
  ['history', 'Medical and health history'],
];
const CATEGORY_KEYS = HEALTH_CATEGORIES.map(([k]) => k);

const NOTE_KINDS = [
  ['consultation', 'Consultation note'],
  ['soap', 'SOAP note'],
  ['follow_up', 'Follow-up note'],
  ['progress', 'Progress note'],
  ['assessment', 'Assessment'],
  ['internal', 'Internal note'],
];
const NOTE_KEYS = NOTE_KINDS.map(([k]) => k);
const SOAP_FIELDS = [['subjective', 'Subjective'], ['objective', 'Objective'], ['assessment', 'Assessment'], ['plan', 'Plan']];

const DOCUMENT_KINDS = [['document', 'Document'], ['lab_result', 'Lab result'], ['photo', 'Photo'], ['consent', 'Consent form'], ['intake', 'Intake form'], ['other', 'Other']];
const DOCUMENT_KEYS = DOCUMENT_KINDS.map(([k]) => k);

const PROFILE_FIELDS = ['date_of_birth', 'preferred_name', 'pronouns', 'occupation', 'emergency_name', 'emergency_relationship', 'emergency_phone', 'summary'];

// DATE columns arrive as Date objects from one driver and strings from another.
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

const canSeeAll = (staff) => staff.permissions.has('clinic.patients.view_all');
const canSeeAny = (staff) => canSeeAll(staff) || staff.permissions.has('clinic.patients.view_assigned');

// SQL fragment limiting patients (alias p) to what this staff member may see.
function scope(staff) {
  if (canSeeAll(staff)) return { sql: 'TRUE', params: [] };
  if (staff.permissions.has('clinic.patients.view_assigned')) {
    return { sql: 'EXISTS (SELECT 1 FROM practitioner_assignments pa WHERE pa.patient_id = p.id AND pa.staff_id = ?)', params: [staff.id] };
  }
  return { sql: 'FALSE', params: [] };
}

// The patient row (with customer contact details) if this staff member may see it, else null.
async function findVisible(staff, patientId) {
  const s = scope(staff);
  const p = await get(`SELECT p.*, c.email, c.first_name, c.last_name, c.phone, c.customer_group
    FROM patients p JOIN customers c ON c.id = p.customer_id WHERE p.id = ? AND ${s.sql}`, patientId, ...s.params);
  if (!p) return null;
  p.profile = vault.open(p.profile_enc) || {};
  p.name = `${p.first_name} ${p.last_name}`.trim() || p.email;
  return p;
}

function readProfile(body) {
  const profile = {};
  for (const f of PROFILE_FIELDS) profile[f] = String(body[f] || '').trim().slice(0, 4000);
  if (profile.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(profile.date_of_birth)) profile.date_of_birth = '';
  return profile;
}

function age(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) years--;
  return years;
}

async function healthItems(patientId) {
  const rows = await all('SELECT * FROM patient_health_items WHERE patient_id = ? ORDER BY active DESC, id', patientId);
  return rows.map((r) => ({ ...r, data: vault.open(r.data_enc) || {} }));
}

async function notes(patientId) {
  const rows = await all('SELECT * FROM clinical_notes WHERE patient_id = ? ORDER BY visit_date DESC, id DESC', patientId);
  return rows.map((r) => ({ ...r, body: vault.open(r.body_enc) || {} }));
}

async function documents(patientId) {
  const rows = await all('SELECT id, patient_id, kind, title_enc, mime, size_bytes, uploaded_by_name, created_at FROM patient_documents WHERE patient_id = ? ORDER BY id DESC', patientId);
  return rows.map((r) => ({ ...r, title: vault.open(r.title_enc) || 'Untitled' }));
}

async function practitioners(patientId) {
  return all(`SELECT s.id, s.name, s.email, pa.is_primary, pa.assigned_at FROM practitioner_assignments pa JOIN staff s ON s.id = pa.staff_id
    WHERE pa.patient_id = ? ORDER BY pa.is_primary DESC, s.name`, patientId);
}

// Staff who could be assigned: anyone whose role can see assigned or all patients.
async function assignableStaff() {
  const rows = await all(`SELECT s.id, s.name, s.email, s.role FROM staff s ORDER BY s.name`);
  const { forRole } = require('./permissions');
  const out = [];
  for (const s of rows) {
    const perms = await forRole(s.role);
    if (perms.has('clinic.patients.view_assigned') || perms.has('clinic.patients.view_all')) out.push(s);
  }
  return out;
}

// Chronological patient timeline built from the records themselves (no duplicated event table).
async function timeline(patient) {
  const events = [{ at: patient.created_at, kind: 'patient', text: 'Patient record created; consent to store health information recorded.' }];
  for (const n of await all('SELECT id, kind, visit_date, author_name, signed_at, created_at FROM clinical_notes WHERE patient_id = ?', patient.id)) {
    const label = (NOTE_KINDS.find(([k]) => k === n.kind) || [, 'Note'])[1];
    events.push({ at: n.created_at, kind: 'note', text: `${label} for ${ymd(n.visit_date)} by ${n.author_name || 'staff'}${n.signed_at ? ' (signed)' : ' (draft)'}`, href: `?tab=notes#note-${n.id}` });
  }
  for (const d of await all('SELECT id, kind, uploaded_by_name, created_at FROM patient_documents WHERE patient_id = ?', patient.id)) {
    events.push({ at: d.created_at, kind: 'document', text: `${(DOCUMENT_KINDS.find(([k]) => k === d.kind) || [, 'Document'])[1]} uploaded by ${d.uploaded_by_name || 'staff'}`, href: '?tab=documents' });
  }
  for (const h of await all('SELECT category, created_at FROM patient_health_items WHERE patient_id = ?', patient.id)) {
    events.push({ at: h.created_at, kind: 'health', text: `${(HEALTH_CATEGORIES.find(([k]) => k === h.category) || [, 'Health'])[1]}: entry added`, href: '?tab=health' });
  }
  for (const a of await all('SELECT s.name, pa.assigned_at FROM practitioner_assignments pa JOIN staff s ON s.id = pa.staff_id WHERE pa.patient_id = ?', patient.id)) {
    events.push({ at: a.assigned_at, kind: 'assignment', text: `Assigned to ${a.name}` });
  }
  for (const o of await all("SELECT id, number, total, created_at, source FROM orders WHERE customer_id = ? AND status != 'cancelled'", patient.customer_id)) {
    events.push({ at: o.created_at, kind: 'order', text: `Order #${o.number}${o.source === 'pos' ? ' (in person)' : ''}`, href: `/admin/orders/${o.id}`, total: o.total });
  }
  return events.sort((a, b) => new Date(b.at) - new Date(a.at));
}

module.exports = {
  HEALTH_CATEGORIES, CATEGORY_KEYS, NOTE_KINDS, NOTE_KEYS, SOAP_FIELDS, DOCUMENT_KINDS, DOCUMENT_KEYS, PROFILE_FIELDS,
  ymd, canSeeAll, canSeeAny, scope, findVisible, readProfile, age, healthItems, notes, documents, practitioners, assignableStaff, timeline,
};
