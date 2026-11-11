'use strict';
// Clinic, part two: intake/assessment form builder, care plans, progress logs, secure messages and
// patient education. Patient-specific content is encrypted with vault.js; form and lesson
// templates are not patient data and stay readable.
const { get, all, run, insert, tx } = require('./db');
const vault = require('./vault');
const mailer = require('./mailer');
const settings = require('./settings');

/* ---------- Form builder ---------- */

const FIELD_TYPES = [
  ['heading', 'Section heading'], ['text', 'Short answer'], ['textarea', 'Long answer'], ['choice', 'Multiple choice (one)'],
  ['checkboxes', 'Checkboxes (several)'], ['select', 'Dropdown'], ['date', 'Date'], ['scale', 'Scale 0–10'], ['file', 'File upload'], ['signature', 'Signature (typed name)'],
];
const FIELD_KEYS = FIELD_TYPES.map(([k]) => k);
const FORM_KINDS = [
  ['intake', 'New patient intake'], ['health_history', 'Health history'], ['lifestyle', 'Lifestyle assessment'], ['digestive', 'Digestive health assessment'],
  ['stress', 'Stress assessment'], ['sleep', 'Sleep assessment'], ['follow_up', 'Follow-up questionnaire'], ['consent', 'Consent form'], ['custom', 'Custom assessment'],
];

const slug = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'q') + `_${i}`;

// Parses the builder's posted rows into clean field definitions.
function parseFields(rows) {
  const fields = [];
  rows.forEach((r, i) => {
    if (!r || r.remove === '1') return;
    const type = FIELD_KEYS.includes(r.type) ? r.type : null;
    const label = String(r.label || '').trim().slice(0, 300);
    if (!type || !label) return;
    const f = { id: r.id && /^[a-z0-9_]+$/.test(r.id) ? r.id : slug(label, i), type, label, help: String(r.help || '').trim().slice(0, 300), required: r.required === '1' && type !== 'heading' };
    if (['choice', 'checkboxes', 'select'].includes(type)) f.options = String(r.options || '').split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean).slice(0, 30);
    if (r.cond_field && r.cond_value) f.condition = { field: String(r.cond_field), equals: String(r.cond_value).trim() };
    fields.push(f);
  });
  // Ids must be unique and conditions must point at an earlier field.
  const seen = new Set();
  for (const f of fields) { while (seen.has(f.id)) f.id += 'x'; seen.add(f.id); }
  fields.forEach((f, i) => { if (f.condition && !fields.slice(0, i).some((p) => p.id === f.condition.field)) delete f.condition; });
  return fields;
}

const visible = (f, answers) => !f.condition || [].concat(answers[f.condition.field] ?? []).map(String).includes(f.condition.equals);

// Validates posted answers against the fields. Returns { answers, errors }.
function readAnswers(fields, body, files = {}) {
  const answers = {};
  const errors = [];
  for (const f of fields) {
    if (f.type === 'heading') continue;
    let v = body[`f_${f.id}`];
    if (f.type === 'checkboxes') v = [].concat(v || []).map(String).filter((x) => f.options.includes(x));
    else if (['choice', 'select'].includes(f.type)) v = f.options.includes(String(v)) ? String(v) : '';
    else if (f.type === 'scale') v = v === '' || v === undefined ? '' : Math.max(0, Math.min(10, Number(v) || 0));
    else if (f.type === 'date') v = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '';
    else if (f.type === 'file') v = files[f.id] || '';
    else v = String(v || '').trim().slice(0, 20000);
    answers[f.id] = v;
  }
  for (const f of fields) {
    if (!f.required || !visible(f, answers)) continue;
    const v = answers[f.id];
    if (v === '' || (Array.isArray(v) && !v.length)) errors.push(`“${f.label}” is required.`);
  }
  return { answers, errors };
}

async function submitForm({ assignment, form, patientId, answers, by, signature }) {
  return tx(async () => {
    const id = await insert(`INSERT INTO form_submissions (form_id, form_version, fields_snapshot, patient_id, answers_enc, submitted_by, signature_enc)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, form.id, form.version, form.fields, patientId, vault.seal(answers), by, signature ? vault.seal(signature) : null);
    if (assignment) await run("UPDATE form_assignments SET status = 'submitted', submission_id = ? WHERE id = ?", id, assignment.id);
    return id;
  });
}

async function submissions(patientId) {
  const rows = await all(`SELECT s.*, f.name AS form_name, f.kind FROM form_submissions s JOIN intake_forms f ON f.id = s.form_id WHERE s.patient_id = ? ORDER BY s.id DESC`, patientId);
  return rows.map((r) => ({ ...r, fields: JSON.parse(r.fields_snapshot), answers: vault.open(r.answers_enc) || {}, signature: r.signature_enc ? vault.open(r.signature_enc) : null }));
}

/* ---------- Care plans ---------- */

const ITEM_KINDS = [
  ['herbal', 'Herbal recommendation'], ['formula', 'Preparation / formula'], ['product', 'Product'], ['supplement', 'Supplement'],
  ['nutrition', 'Nutrition'], ['diet', 'Dietary protocol'], ['lifestyle', 'Lifestyle'], ['routine', 'Daily routine'], ['lesson', 'Lesson'],
  ['resource', 'Information sheet / resource'], ['recipe', 'Recipe'], ['goal', 'Goal'], ['task', 'Checklist item'], ['follow_up', 'Follow-up'], ['assessment', 'Progress assessment'],
];
const ITEM_KEYS = ITEM_KINDS.map(([k]) => k);

async function plans(patientId, { sharedOnly = false } = {}) {
  const rows = await all(`SELECT * FROM care_plans WHERE patient_id = ? ${sharedOnly ? "AND shared_with_patient = 1 AND status IN ('active', 'completed')" : ''} ORDER BY status = 'active' DESC, id DESC`, patientId);
  return rows.map((p) => ({ ...p, content: vault.open(p.content_enc) || {} }));
}

async function plan(planId, patientId) {
  const p = await get('SELECT * FROM care_plans WHERE id = ? AND patient_id = ?', planId, patientId);
  if (!p) return null;
  p.content = vault.open(p.content_enc) || {};
  const items = await all(`SELECT i.*, f.name AS formula_name, f.status AS formula_status, v.price, v.title AS variant_title, pr.title AS product_title, pr.handle,
      v.inventory_qty, v.track_inventory, v.continue_selling, pr.status AS product_status, h.common_name AS herb_name, h.slug AS herb_slug, l.title AS lesson_title
    FROM care_plan_items i LEFT JOIN formulas f ON f.id = i.formula_id LEFT JOIN variants v ON v.id = i.variant_id LEFT JOIN products pr ON pr.id = v.product_id
    LEFT JOIN herbs h ON h.id = i.herb_id LEFT JOIN lessons l ON l.id = i.lesson_id WHERE i.plan_id = ? ORDER BY i.position, i.id`, p.id);
  const today = new Date().toISOString().slice(0, 10);
  for (const i of items) {
    i.content = vault.open(i.content_enc) || {};
    const done = await all('SELECT done_on FROM care_plan_completions WHERE item_id = ? ORDER BY done_on DESC LIMIT 60', i.id);
    i.doneDates = done.map((d) => (d.done_on instanceof Date ? d.done_on.toISOString() : String(d.done_on)).slice(0, 10));
    i.doneToday = i.doneDates.includes(today);
  }
  p.items = items;
  p.versions = await all('SELECT id, version, saved_by, created_at FROM care_plan_versions WHERE plan_id = ? ORDER BY version DESC', p.id);
  return p;
}

async function snapshotPlan(planId, staffName) {
  const p = await get('SELECT * FROM care_plans WHERE id = ?', planId);
  const items = await all('SELECT kind, content_enc, formula_id, variant_id, herb_id, lesson_id, is_task, start_date, end_date, position FROM care_plan_items WHERE plan_id = ? ORDER BY position, id', planId);
  const snap = { content: vault.open(p.content_enc), status: p.status, start_date: p.start_date, end_date: p.end_date, items: items.map((i) => ({ ...i, content: vault.open(i.content_enc), content_enc: undefined })) };
  await run(`INSERT INTO care_plan_versions (plan_id, version, snapshot_enc, saved_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (plan_id, version) DO UPDATE SET snapshot_enc = EXCLUDED.snapshot_enc, saved_by = EXCLUDED.saved_by, created_at = now()`, planId, p.version, vault.seal(snap), staffName);
}

// Completion over the last `days` days for daily tasks, and overall for one-off ones.
function progress(p, days = 14) {
  const tasks = p.items.filter((i) => i.is_task);
  if (!tasks.length) return null;
  const today = new Date();
  let possible = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.content.frequency === 'daily') {
      for (let d = 0; d < days; d++) {
        const day = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
        const s = t.start_date ? (t.start_date instanceof Date ? t.start_date.toISOString() : String(t.start_date)).slice(0, 10) : null;
        if (s && day < s) continue;
        possible++;
        if (t.doneDates.includes(day)) done++;
      }
    } else { possible++; if (t.doneDates.length) done++; }
  }
  return { possible, done, percent: possible ? Math.round((done / possible) * 100) : 0 };
}

/* ---------- Progress logs ---------- */

async function logs(patientId, limit = 120) {
  const rows = await all('SELECT * FROM patient_logs WHERE patient_id = ? ORDER BY log_date DESC, id DESC LIMIT ?', patientId, limit);
  return rows.map((r) => ({ ...r, data: vault.open(r.data_enc) || {}, day: (r.log_date instanceof Date ? r.log_date.toISOString() : String(r.log_date)).slice(0, 10) }));
}

function readLog(body) {
  const kind = ['journal', 'symptom', 'wellness', 'review'].includes(body.kind) ? body.kind : 'journal';
  const score = (v) => (v === '' || v === undefined ? null : Math.max(0, Math.min(10, Number(v) || 0)));
  const data = { note: String(body.note || '').trim().slice(0, 10000) };
  if (kind === 'symptom') Object.assign(data, { symptom: String(body.symptom || '').trim().slice(0, 200), severity: score(body.severity) });
  if (kind === 'wellness') Object.assign(data, { energy: score(body.energy), sleep: score(body.sleep), mood: score(body.mood), stress: score(body.stress), digestion: score(body.digestion) });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.log_date || '')) ? body.log_date : new Date().toISOString().slice(0, 10);
  const empty = !data.note && !data.symptom && !['energy', 'sleep', 'mood', 'stress', 'digestion', 'severity'].some((k) => data[k] !== null && data[k] !== undefined);
  return { kind, data, date, empty };
}

// Series for charts: { symptoms: { name: [{day, value}] }, wellness: { metric: [{day, value}] } }
function series(list) {
  const symptoms = {};
  const wellness = {};
  for (const l of [...list].reverse()) {
    if (l.kind === 'symptom' && l.data.symptom && l.data.severity !== null && l.data.severity !== undefined) (symptoms[l.data.symptom] = symptoms[l.data.symptom] || []).push({ day: l.day, value: l.data.severity });
    if (l.kind === 'wellness') for (const k of ['energy', 'sleep', 'mood', 'stress', 'digestion']) if (l.data[k] !== null && l.data[k] !== undefined) (wellness[k] = wellness[k] || []).push({ day: l.day, value: l.data[k] });
  }
  return { symptoms, wellness };
}

/* ---------- Secure messages ---------- */

async function threads(patientId) {
  const rows = await all(`SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender_type = 'patient' AND m.read_by_staff_at IS NULL) AS unread_staff,
      (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender_type = 'staff' AND m.read_by_patient_at IS NULL) AS unread_patient
    FROM message_threads t WHERE t.patient_id = ? ORDER BY t.last_message_at DESC`, patientId);
  return rows.map((t) => ({ ...t, subject: vault.open(t.subject_enc) || '' }));
}

async function thread(threadId, patientId) {
  const t = await get('SELECT * FROM message_threads WHERE id = ? AND patient_id = ?', threadId, patientId);
  if (!t) return null;
  t.subject = vault.open(t.subject_enc) || '';
  t.messages = (await all('SELECT * FROM messages WHERE thread_id = ? ORDER BY id', t.id)).map((m) => ({ ...m, body: vault.open(m.body_enc) || '' }));
  return t;
}

/**
 * Adds a message. Notifications by email never include the message or subject — only that a
 * secure message is waiting, with a link to sign in.
 */
async function postMessage({ patientId, threadId, subject, body, sender, staff }) {
  const id = await tx(async () => {
    let tid = threadId;
    if (!tid) tid = await insert('INSERT INTO message_threads (patient_id, subject_enc) VALUES (?, ?)', patientId, vault.seal(String(subject || 'Message').slice(0, 200)));
    await insert('INSERT INTO messages (thread_id, sender_type, sender_staff_id, sender_name, body_enc) VALUES (?, ?, ?, ?, ?)',
      tid, sender, staff ? staff.id : null, staff ? staff.name : '', vault.seal(String(body).slice(0, 20000)));
    await run('UPDATE message_threads SET last_message_at = now() WHERE id = ?', tid);
    return tid;
  });
  const store = settings.load('store');
  const base = process.env.BASE_URL || process.env.URL || '';
  const comms = require('./comms');
  if (sender === 'staff') {
    const p = await get('SELECT c.email, c.first_name, c.phone, c.sms_opt_in, c.email_reminders FROM patients p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?', patientId);
    if (p) await comms.send('message_waiting', p, { link: `${base}/account/clinic/messages` });
  } else {
    const assigned = await all('SELECT staff_id FROM practitioner_assignments WHERE patient_id = ?', patientId);
    for (const a of assigned) await comms.notifyStaff({ kind: 'message', title: 'New secure message from a patient', link: `/admin/clinic/patients/${patientId}?tab=messages`, staffId: a.staff_id });
    if (!assigned.length) await comms.notifyStaff({ kind: 'message', title: 'New secure message from a patient', link: `/admin/clinic/patients/${patientId}?tab=messages`, permission: 'clinic.patients.view_all' });
    // Tell assigned practitioners (or the clinic inbox) that a message arrived — again without content.
    const to = (await all('SELECT s.email FROM practitioner_assignments pa JOIN staff s ON s.id = pa.staff_id WHERE pa.patient_id = ?', patientId)).map((r) => r.email);
    const fallback = settings.load('notifications').staff_order_email;
    for (const email of to.length ? to : fallback ? [fallback] : []) {
      await mailer.sendRaw(email, `[${store.name}] New secure patient message`, `<p>A patient sent a new secure message. <a href="${base}/admin/clinic/patients/${patientId}?tab=messages">Open it in the admin</a>.</p>`);
    }
  }
  return id;
}

/* ---------- Education ---------- */

const LESSON_KINDS = [['lesson', 'Lesson'], ['info_sheet', 'Information sheet'], ['guide', 'Downloadable guide'], ['recipe', 'Recipe'], ['preparation', 'Preparation instructions'], ['video', 'Video'], ['checklist', 'Checklist']];

// Lessons assigned to a patient (directly, via a course or a care plan), with progress.
async function assignedLessons(patientId) {
  const rows = await all(`SELECT DISTINCT ON (l.id) l.*, a.assigned_at, a.due_at, a.assigned_by, c.title AS course_title, lp.completed_at, lp.acknowledged_at, lp.quiz_score, lp.quiz_total
    FROM lesson_assignments a
    LEFT JOIN course_lessons cl ON cl.course_id = a.course_id
    JOIN lessons l ON l.id = COALESCE(a.lesson_id, cl.lesson_id)
    LEFT JOIN courses c ON c.id = a.course_id
    LEFT JOIN lesson_progress lp ON lp.patient_id = a.patient_id AND lp.lesson_id = l.id
    WHERE a.patient_id = ? AND l.status = 'published' ORDER BY l.id, a.assigned_at`, patientId);
  return rows.sort((a, b) => new Date(b.assigned_at) - new Date(a.assigned_at));
}

async function canSeeLesson(patientId, lessonId) {
  return Boolean(await get(`SELECT 1 FROM lesson_assignments a LEFT JOIN course_lessons cl ON cl.course_id = a.course_id
    WHERE a.patient_id = ? AND (a.lesson_id = ? OR cl.lesson_id = ?)`, patientId, lessonId, lessonId));
}

module.exports = {
  FIELD_TYPES, FIELD_KEYS, FORM_KINDS, parseFields, visible, readAnswers, submitForm, submissions,
  ITEM_KINDS, ITEM_KEYS, plans, plan, snapshotPlan, progress,
  logs, readLog, series, threads, thread, postMessage, LESSON_KINDS, assignedLessons, canSeeLesson,
};
