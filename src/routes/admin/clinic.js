'use strict';
// Clinic → Patients. Every route here goes through clinic.findVisible(), which applies the
// assignment rule, and every view or change of a record is written to the audit log (without any
// clinical content). Clinical text and files are encrypted with vault.js before storage.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const clinic = require('../../clinic');
const clinic2 = require('../../clinic2');
const comms = require('../../comms');
const vault = require('../../vault');
const audit = require('../../audit');
const storage = require('../../storage');
const cases = require('../../cases');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, paginate, token } = require('../../utils');

const router = express.Router();

router.use((req, res, next) => {
  if (!clinic.canSeeAny(res.locals.staff)) {
    audit.record(req, 'access.denied', { details: { permission: 'clinic', method: req.method, path: req.originalUrl.split('?')[0] } });
    return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include access to clinic records.' });
  }
  if (!vault.configured()) return res.status(503).render('admin/clinic/locked', { title: 'Clinic records locked' });
  Object.assign(res.locals, {
    HEALTH_CATEGORIES: clinic.HEALTH_CATEGORIES, NOTE_KINDS: clinic.NOTE_KINDS, SOAP_FIELDS: clinic.SOAP_FIELDS,
    DOCUMENT_KINDS: clinic.DOCUMENT_KINDS, age: clinic.age, ymd: clinic.ymd, ITEM_KINDS: clinic2.ITEM_KINDS, FIELD_TYPES: clinic2.FIELD_TYPES, visibleField: clinic2.visible,
  });
  next();
});

const canManage = (res) => res.locals.can('clinic.records.manage');
function requireManage(req, res, next) {
  if (canManage(res)) return next();
  audit.record(req, 'access.denied', { details: { permission: 'clinic.records.manage', path: req.originalUrl.split('?')[0] } });
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role can view clinic records but not change them.' });
}

const notFound = (res) => res.status(404).render('admin/error', { title: 'Not found', message: 'This patient record does not exist or is not assigned to you.' });

// Loads the patient for :id (if visible) into req.patient.
async function patientParam(req, res, next) {
  const patient = await clinic.findVisible(res.locals.staff, toInt(req.params.id));
  if (!patient) {
    await audit.record(req, 'patient.access_refused', { entityType: 'patient', entityId: toInt(req.params.id) });
    return notFound(res);
  }
  req.patient = patient;
  next();
}

const back = (req, tab) => `/admin/clinic/patients/${req.patient.id}${tab ? `?tab=${tab}` : ''}`;
const text = (v, max = 20000) => String(v || '').trim().slice(0, max);

/* ---------- List and create ---------- */

router.get('/', (req, res) => res.redirect('/admin/clinic/patients'));

router.get('/patients', async (req, res) => {
  const s = clinic.scope(res.locals.staff);
  const where = [s.sql];
  const params = [...s.params];
  const q = String(req.query.q || '').trim();
  const status = ['active', 'inactive', 'archived'].includes(req.query.status) ? req.query.status : 'active';
  where.push('p.status = ?'); params.push(status);
  if (q) { where.push("(c.email ILIKE ? OR (c.first_name || ' ' || c.last_name) ILIKE ? OR c.phone ILIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (req.query.mine === '1') { where.push('EXISTS (SELECT 1 FROM practitioner_assignments m WHERE m.patient_id = p.id AND m.staff_id = ?)'); params.push(res.locals.staff.id); }
  const total = (await get(`SELECT COUNT(*) AS n FROM patients p JOIN customers c ON c.id = p.customer_id WHERE ${where.join(' AND ')}`, ...params)).n;
  const pager = paginate(total, req.query.page, 25);
  const patients = await all(`SELECT p.id, p.status, p.created_at, c.email, c.first_name, c.last_name, c.phone,
      (SELECT string_agg(st.name, ', ' ORDER BY pa.is_primary DESC, st.name) FROM practitioner_assignments pa JOIN staff st ON st.id = pa.staff_id WHERE pa.patient_id = p.id) AS practitioners,
      (SELECT MAX(visit_date) FROM clinical_notes n WHERE n.patient_id = p.id) AS last_visit
    FROM patients p JOIN customers c ON c.id = p.customer_id WHERE ${where.join(' AND ')}
    ORDER BY lower(c.last_name), lower(c.first_name), p.id LIMIT ? OFFSET ?`, ...params, pager.perPage, pager.offset);
  res.render('admin/clinic/patients', { title: 'Patients', patients, pager, q, status, mine: req.query.mine === '1', seesAll: clinic.canSeeAll(res.locals.staff) });
});

router.get('/patients/new', requireManage, async (req, res) => {
  res.render('admin/clinic/patient-new', { title: 'New patient', prefill: { email: String(req.query.email || '') } });
});

router.post('/patients/new', requireManage, async (req, res) => {
  const staff = res.locals.staff;
  const email = String(req.body.email || '').trim().toLowerCase();
  const fail = (msg) => { flash(req, 'error', msg); return res.redirect(`/admin/clinic/patients/new?email=${encodeURIComponent(email)}`); };
  if (!email.includes('@')) return fail('Enter the patient\'s email address. It links the record to their customer account.');
  if (req.body.consent !== '1') return fail('Record the patient\'s consent to storing their health information before creating a record.');
  const profile = clinic.readProfile(req.body);
  let customer = await get('SELECT * FROM customers WHERE email = ?', email);
  if (customer && await get('SELECT 1 FROM patients WHERE customer_id = ?', customer.id)) {
    const existing = await get('SELECT id FROM patients WHERE customer_id = ?', customer.id);
    if (await clinic.findVisible(staff, existing.id)) return res.redirect(`/admin/clinic/patients/${existing.id}`);
    return fail('This person already has a clinic record. Ask a clinic manager to assign you to it.');
  }
  const id = await tx(async () => {
    if (!customer) {
      const cid = await insert('INSERT INTO customers (email, first_name, last_name, phone) VALUES (?, ?, ?, ?)',
        email, text(req.body.first_name, 200), text(req.body.last_name, 200), text(req.body.phone, 50));
      customer = { id: cid };
    } else if (req.body.first_name || req.body.last_name || req.body.phone) {
      // Fill gaps in the customer record without overwriting what the customer entered.
      await run(`UPDATE customers SET first_name = COALESCE(NULLIF(first_name, ''), ?), last_name = COALESCE(NULLIF(last_name, ''), ?),
        phone = COALESCE(NULLIF(phone, ''), ?) WHERE id = ?`, text(req.body.first_name, 200), text(req.body.last_name, 200), text(req.body.phone, 50), customer.id);
    }
    const pid = await insert(`INSERT INTO patients (customer_id, profile_enc, consent_at, consent_recorded_by, created_by) VALUES (?, ?, now(), ?, ?)`,
      customer.id, vault.seal(profile), staff.name, staff.id);
    // A practitioner who can only see assigned patients is assigned to the record they create.
    if (!clinic.canSeeAll(staff) || req.body.assign_me === '1') {
      await run('INSERT INTO practitioner_assignments (patient_id, staff_id, is_primary) VALUES (?, ?, 1) ON CONFLICT DO NOTHING', pid, staff.id);
    }
    return pid;
  });
  await audit.record(req, 'patient.created', { entityType: 'patient', entityId: id });
  flash(req, 'success', 'Patient record created.');
  res.redirect(`/admin/clinic/patients/${id}`);
});

/* ---------- Record ---------- */

const TABS = ['overview', 'cases', 'health', 'notes', 'forms', 'plans', 'progress', 'learning', 'messages', 'documents', 'timeline'];

router.get('/patients/:id', patientParam, async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'overview';
  const p = req.patient;
  const [health, notes, documents, practitioners] = await Promise.all([
    clinic.healthItems(p.id), clinic.notes(p.id), clinic.documents(p.id), clinic.practitioners(p.id),
  ]);
  const extra = {};
  if (tab === 'timeline') extra.events = await clinic.timeline(p);
  if (tab === 'forms') {
    extra.assignments = await all(`SELECT a.*, f.name FROM form_assignments a JOIN intake_forms f ON f.id = a.form_id WHERE a.patient_id = ? ORDER BY a.id DESC`, p.id);
    extra.submissionsList = await clinic2.submissions(p.id);
    extra.publishedForms = await all("SELECT id, name FROM intake_forms WHERE status = 'published' ORDER BY name");
  }
  if (tab === 'plans') {
    extra.plansList = await clinic2.plans(p.id);
    const planId = toInt(req.query.plan) || (extra.plansList[0] && extra.plansList[0].id);
    extra.activePlan = planId ? await clinic2.plan(planId, p.id) : null;
    if (extra.activePlan) extra.planProgress = clinic2.progress(extra.activePlan);
    extra.planOptions = {
      formulas: await all("SELECT id, name FROM formulas WHERE status = 'approved' ORDER BY lower(name)"),
      variants: await all("SELECT v.id, v.title, p.title AS product_title FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' ORDER BY lower(p.title), v.position"),
      herbs: await all("SELECT id, common_name, latin_name FROM herbs WHERE status = 'published' ORDER BY lower(common_name)"),
      lessons: await all("SELECT id, title FROM lessons WHERE status = 'published' ORDER BY lower(title)"),
    };
  }
  if (tab === 'progress') {
    extra.logList = await clinic2.logs(p.id);
    extra.logSeries = clinic2.series(extra.logList);
  }
  if (tab === 'learning') {
    extra.lessonsAssigned = await clinic2.assignedLessons(p.id);
    extra.lessonOptions = await all("SELECT id, title, kind FROM lessons WHERE status = 'published' ORDER BY lower(title)");
    extra.courseOptions = await all("SELECT id, title FROM courses WHERE status = 'published' ORDER BY lower(title)");
  }
  if (tab === 'messages') {
    extra.threadList = await clinic2.threads(p.id);
    const tid = toInt(req.query.thread) || (extra.threadList[0] && extra.threadList[0].id);
    extra.activeThread = tid ? await clinic2.thread(tid, p.id) : null;
    if (extra.activeThread) await run("UPDATE messages SET read_by_staff_at = now() WHERE thread_id = ? AND sender_type = 'patient' AND read_by_staff_at IS NULL", extra.activeThread.id);
  }
  if (tab === 'cases') {
    extra.casesList = await cases.forPatient(p.id);
    extra.referrers = await all('SELECT id, name, organisation FROM referrers WHERE archived = 0 ORDER BY lower(name)');
  }
  if (tab === 'notes' || tab === 'plans') extra.openCases = await cases.openFor(p.id);
  if (tab === 'notes') extra.templates = await all('SELECT * FROM note_templates WHERE owner_id IS NULL OR owner_id = ? ORDER BY name', res.locals.staff.id);
  if (tab === 'overview' && res.locals.can('clinic.assignments.manage')) extra.assignable = await clinic.assignableStaff();
  await audit.record(req, 'patient.viewed', { entityType: 'patient', entityId: p.id, details: { tab } });
  res.render('admin/clinic/patient', {
    title: p.name, patient: p, tab, health, notes, documents, practitioners, canManage: canManage(res),
    editNote: toInt(req.query.edit), amend: toInt(req.query.amend), ...extra,
  });
});

router.post('/patients/:id/profile', requireManage, patientParam, async (req, res) => {
  const profile = clinic.readProfile(req.body);
  await tx(async () => {
    await run('UPDATE patients SET profile_enc = ?, updated_at = now() WHERE id = ?', vault.seal(profile), req.patient.id);
    await run('UPDATE customers SET first_name = ?, last_name = ?, phone = ? WHERE id = ?',
      text(req.body.first_name, 200), text(req.body.last_name, 200), text(req.body.phone, 50), req.patient.customer_id);
  });
  await audit.record(req, 'patient.updated', { entityType: 'patient', entityId: req.patient.id, details: { part: 'profile' } });
  flash(req, 'success', 'Profile saved.');
  res.redirect(back(req));
});

router.post('/patients/:id/status', requireManage, patientParam, async (req, res) => {
  const status = ['active', 'inactive', 'archived'].includes(req.body.status) ? req.body.status : 'active';
  await run('UPDATE patients SET status = ?, updated_at = now() WHERE id = ?', status, req.patient.id);
  await audit.record(req, 'patient.status_changed', { entityType: 'patient', entityId: req.patient.id, details: { from: req.patient.status, to: status } });
  flash(req, 'success', `Patient marked ${status}.`);
  res.redirect(back(req));
});

/* ---------- Health history ---------- */

function readItem(body) {
  return { name: text(body.name, 500), details: text(body.details, 5000), since: text(body.since, 100) };
}

router.post('/patients/:id/health', requireManage, patientParam, async (req, res) => {
  const category = clinic.CATEGORY_KEYS.includes(req.body.category) ? req.body.category : null;
  const data = readItem(req.body);
  if (!category || !data.name) {
    flash(req, 'error', 'Choose a section and enter at least a name or short description.');
    return res.redirect(back(req, 'health'));
  }
  const id = await insert('INSERT INTO patient_health_items (patient_id, category, data_enc, recorded_by) VALUES (?, ?, ?, ?)',
    req.patient.id, category, vault.seal(data), res.locals.staff.id);
  await audit.record(req, 'patient.health_added', { entityType: 'patient', entityId: req.patient.id, details: { category, item: id } });
  res.redirect(back(req, 'health'));
});

async function healthItem(req) {
  return get('SELECT * FROM patient_health_items WHERE id = ? AND patient_id = ?', toInt(req.params.itemId), req.patient.id);
}

router.post('/patients/:id/health/:itemId', requireManage, patientParam, async (req, res) => {
  const item = await healthItem(req);
  if (!item) return notFound(res);
  if (req.body.toggle === '1') {
    await run('UPDATE patient_health_items SET active = ?, updated_at = now() WHERE id = ?', item.active ? 0 : 1, item.id);
  } else {
    const data = readItem(req.body);
    if (!data.name) { flash(req, 'error', 'The entry needs a name.'); return res.redirect(back(req, 'health')); }
    await run('UPDATE patient_health_items SET data_enc = ?, updated_at = now() WHERE id = ?', vault.seal(data), item.id);
  }
  await audit.record(req, 'patient.health_updated', { entityType: 'patient', entityId: req.patient.id, details: { category: item.category, item: item.id } });
  res.redirect(back(req, 'health'));
});

router.post('/patients/:id/health/:itemId/delete', requireManage, patientParam, async (req, res) => {
  const item = await healthItem(req);
  if (!item) return notFound(res);
  await run('DELETE FROM patient_health_items WHERE id = ?', item.id);
  await audit.record(req, 'patient.health_deleted', { entityType: 'patient', entityId: req.patient.id, details: { category: item.category, item: item.id } });
  flash(req, 'success', 'Entry removed.');
  res.redirect(back(req, 'health'));
});

/* ---------- Clinical notes ---------- */

function readNote(body) {
  const kind = clinic.NOTE_KEYS.includes(body.kind) ? body.kind : 'consultation';
  const content = kind === 'soap'
    ? Object.fromEntries(clinic.SOAP_FIELDS.map(([k]) => [k, text(body[k], 50000)]))
    : { text: text(body.text, 50000) };
  const empty = Object.values(content).every((v) => !v);
  const visit = /^\d{4}-\d{2}-\d{2}$/.test(String(body.visit_date || '')) ? body.visit_date : new Date().toISOString().slice(0, 10);
  return { kind, content, empty, visit };
}

router.post('/patients/:id/notes', requireManage, patientParam, async (req, res) => {
  const n = readNote(req.body);
  if (n.empty) { flash(req, 'error', 'The note is empty.'); return res.redirect(back(req, 'notes')); }
  const amends = toInt(req.body.amends_note_id);
  const amendsOk = amends && await get('SELECT 1 FROM clinical_notes WHERE id = ? AND patient_id = ? AND signed_at IS NOT NULL', amends, req.patient.id);
  const sign = req.body.sign === '1';
  const caseId = await cases.validFor(req.patient.id, req.body.case_id);
  const id = await insert(`INSERT INTO clinical_notes (patient_id, author_id, author_name, kind, visit_date, body_enc, internal, amends_note_id, signed_at, case_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ${sign ? 'now()' : 'NULL'}, ?)`, req.patient.id, res.locals.staff.id, res.locals.staff.name, n.kind, n.visit,
  vault.seal(n.content), amendsOk ? amends : null, caseId);
  await audit.record(req, sign ? 'patient.note_signed' : 'patient.note_created', { entityType: 'patient', entityId: req.patient.id, details: { note: id, kind: n.kind, amends: amendsOk ? amends : undefined } });
  flash(req, 'success', sign ? 'Note signed and locked.' : 'Draft note saved. Sign it when it\'s final.');
  res.redirect(`${back(req, 'notes')}#note-${id}`);
});

async function ownDraft(req, res) {
  const note = await get('SELECT * FROM clinical_notes WHERE id = ? AND patient_id = ?', toInt(req.params.noteId), req.patient.id);
  if (!note) return { error: 'not found' };
  if (note.signed_at) return { error: 'This note is signed and locked. Add an amendment instead.' };
  if (note.author_id !== res.locals.staff.id) return { error: 'Only the author can edit, sign or delete a draft note.' };
  return { note };
}

router.post('/patients/:id/notes/:noteId', requireManage, patientParam, async (req, res) => {
  const { note, error } = await ownDraft(req, res);
  if (error) { flash(req, 'error', error); return res.redirect(back(req, 'notes')); }
  const n = readNote({ ...req.body, kind: note.kind });
  if (n.empty) { flash(req, 'error', 'The note is empty.'); return res.redirect(back(req, 'notes')); }
  const sign = req.body.sign === '1';
  await run(`UPDATE clinical_notes SET body_enc = ?, visit_date = ?, updated_at = now()${sign ? ', signed_at = now()' : ''} WHERE id = ?`, vault.seal(n.content), n.visit, note.id);
  await audit.record(req, sign ? 'patient.note_signed' : 'patient.note_updated', { entityType: 'patient', entityId: req.patient.id, details: { note: note.id } });
  flash(req, 'success', sign ? 'Note signed and locked.' : 'Draft saved.');
  res.redirect(`${back(req, 'notes')}#note-${note.id}`);
});

router.post('/patients/:id/notes/:noteId/delete', requireManage, patientParam, async (req, res) => {
  const { note, error } = await ownDraft(req, res);
  if (error) { flash(req, 'error', error); return res.redirect(back(req, 'notes')); }
  await run('DELETE FROM clinical_notes WHERE id = ?', note.id);
  await audit.record(req, 'patient.note_deleted', { entityType: 'patient', entityId: req.patient.id, details: { note: note.id } });
  flash(req, 'success', 'Draft deleted.');
  res.redirect(back(req, 'notes'));
});

/* ---------- Documents ---------- */

router.post('/patients/:id/documents', storage.privateUpload.single('file'), verifyCsrf, requireManage, patientParam, async (req, res) => {
  if (!req.file) {
    flash(req, 'error', `Choose a file: ${[...storage.PRIVATE_TYPES.keys()].join(', ')}, up to ${Math.round(storage.MAX_BYTES / 1024 / 1024)} MB.`);
    return res.redirect(back(req, 'documents'));
  }
  const kind = clinic.DOCUMENT_KEYS.includes(req.body.kind) ? req.body.kind : 'document';
  const ext = require('node:path').extname(req.file.originalname).toLowerCase();
  const key = `patients/${req.patient.id}/${token(16)}`;
  await storage.savePrivate(key, vault.sealBuffer(req.file.buffer));
  const title = text(req.body.title, 300) || req.file.originalname.slice(0, 300);
  let id;
  try {
    id = await insert(`INSERT INTO patient_documents (patient_id, kind, title_enc, storage_key, mime, size_bytes, uploaded_by, uploaded_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, req.patient.id, kind, vault.seal(`${title}${title.toLowerCase().endsWith(ext) ? '' : ext}`), key,
    storage.PRIVATE_TYPES.get(ext), req.file.size, res.locals.staff.id, res.locals.staff.name);
  } catch (err) {
    await storage.removePrivate(key).catch(() => {});
    throw err;
  }
  await audit.record(req, 'patient.document_uploaded', { entityType: 'patient', entityId: req.patient.id, details: { document: id, kind, bytes: req.file.size } });
  flash(req, 'success', 'Document uploaded and encrypted.');
  res.redirect(back(req, 'documents'));
});

async function documentRow(req) {
  return get('SELECT * FROM patient_documents WHERE id = ? AND patient_id = ?', toInt(req.params.docId), req.patient.id);
}

router.get('/patients/:id/documents/:docId', patientParam, async (req, res) => {
  const doc = await documentRow(req);
  if (!doc) return notFound(res);
  const body = vault.openBuffer(await storage.readPrivate(doc.storage_key));
  const name = (vault.open(doc.title_enc) || 'document').replace(/[^\w.\- ]+/g, '_');
  await audit.record(req, 'patient.document_viewed', { entityType: 'patient', entityId: req.patient.id, details: { document: doc.id } });
  const inline = req.query.view === '1' && /^(image\/(jpeg|png|webp)|application\/pdf|text\/plain)$/.test(doc.mime);
  res.set({
    'Content-Type': doc.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  }).send(body);
});

router.post('/patients/:id/documents/:docId/share', requireManage, patientParam, async (req, res) => {
  const doc = await documentRow(req);
  if (!doc) return notFound(res);
  await run('UPDATE patient_documents SET shared_with_patient = ? WHERE id = ?', doc.shared_with_patient ? 0 : 1, doc.id);
  await audit.record(req, doc.shared_with_patient ? 'patient.document_unshared' : 'patient.document_shared', { entityType: 'patient', entityId: req.patient.id, details: { document: doc.id } });
  res.redirect(back(req, 'documents'));
});

router.post('/patients/:id/documents/:docId/delete', requireManage, patientParam, async (req, res) => {
  const doc = await documentRow(req);
  if (!doc) return notFound(res);
  await run('DELETE FROM patient_documents WHERE id = ?', doc.id);
  await storage.removePrivate(doc.storage_key).catch((err) => console.error('private file delete failed', err.message));
  await audit.record(req, 'patient.document_deleted', { entityType: 'patient', entityId: req.patient.id, details: { document: doc.id } });
  flash(req, 'success', 'Document deleted.');
  res.redirect(back(req, 'documents'));
});

/* ---------- Practitioner assignments ---------- */

function requireAssign(req, res, next) {
  if (res.locals.can('clinic.assignments.manage')) return next();
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role cannot assign practitioners.' });
}

router.post('/patients/:id/assignments', requireAssign, patientParam, async (req, res) => {
  const staffId = toInt(req.body.staff_id);
  const allowed = (await clinic.assignableStaff()).find((s) => s.id === staffId);
  if (!allowed) { flash(req, 'error', 'Choose a practitioner whose role can see assigned patients.'); return res.redirect(back(req)); }
  await tx(async () => {
    if (req.body.is_primary === '1') await run('UPDATE practitioner_assignments SET is_primary = 0 WHERE patient_id = ?', req.patient.id);
    await run(`INSERT INTO practitioner_assignments (patient_id, staff_id, is_primary) VALUES (?, ?, ?)
      ON CONFLICT (patient_id, staff_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`, req.patient.id, staffId, req.body.is_primary === '1' ? 1 : 0);
  });
  await audit.record(req, 'patient.assigned', { entityType: 'patient', entityId: req.patient.id, details: { staff: staffId, name: allowed.name } });
  flash(req, 'success', `${allowed.name} assigned.`);
  res.redirect(back(req));
});

router.post('/patients/:id/assignments/:staffId/delete', requireAssign, patientParam, async (req, res) => {
  const staffId = toInt(req.params.staffId);
  await run('DELETE FROM practitioner_assignments WHERE patient_id = ? AND staff_id = ?', req.patient.id, staffId);
  await audit.record(req, 'patient.unassigned', { entityType: 'patient', entityId: req.patient.id, details: { staff: staffId } });
  flash(req, 'success', 'Assignment removed.');
  res.redirect(back(req));
});

/* ---------- Permanent deletion (owner only) ---------- */

router.post('/patients/:id/delete', patientParam, async (req, res) => {
  if (res.locals.staff.role !== 'owner') return res.status(403).render('admin/error', { title: 'Permission required', message: 'Only an owner can permanently delete a patient record.' });
  if (String(req.body.confirm || '').trim().toLowerCase() !== req.patient.email.toLowerCase()) {
    flash(req, 'error', 'Type the patient\'s email address to confirm permanent deletion.');
    return res.redirect(back(req));
  }
  const keys = (await all('SELECT storage_key FROM patient_documents WHERE patient_id = ?', req.patient.id)).map((d) => d.storage_key);
  await run('DELETE FROM patients WHERE id = ?', req.patient.id);
  for (const key of keys) await storage.removePrivate(key).catch((err) => console.error('private file delete failed', err.message));
  await audit.record(req, 'patient.deleted', { entityType: 'patient', entityId: req.patient.id, details: { documents: keys.length } });
  flash(req, 'success', 'The clinic record and its documents were permanently deleted. The customer account and orders were kept.');
  res.redirect('/admin/clinic/patients');
});

/* ---------- Forms: assign, fill in for the patient, review ---------- */

router.post('/patients/:id/forms', requireManage, patientParam, async (req, res) => {
  const form = await get("SELECT * FROM intake_forms WHERE id = ? AND status = 'published'", toInt(req.body.form_id));
  if (!form) { flash(req, 'error', 'Choose a published form.'); return res.redirect(back(req, 'forms')); }
  await insert('INSERT INTO form_assignments (form_id, patient_id, assigned_by, due_at) VALUES (?, ?, ?, ?)', form.id, req.patient.id, res.locals.staff.name,
    /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_at || '') ? req.body.due_at : null);
  await audit.record(req, 'patient.form_assigned', { entityType: 'patient', entityId: req.patient.id, details: { form: form.id } });
  await comms.send('form_assigned', req.patient, { link: `${comms.base()}/account/clinic` });
  flash(req, 'success', 'Form assigned. The patient was emailed a link (without any health details).');
  res.redirect(back(req, 'forms'));
});

router.post('/patients/:id/forms/:submissionId/review', requireManage, patientParam, async (req, res) => {
  const sId = toInt(req.params.submissionId);
  await run('UPDATE form_submissions SET reviewed_by = ?, reviewed_at = now() WHERE id = ? AND patient_id = ?', res.locals.staff.name, sId, req.patient.id);
  await run("UPDATE form_assignments SET status = 'reviewed' WHERE submission_id = ?", sId);
  await audit.record(req, 'patient.form_reviewed', { entityType: 'patient', entityId: req.patient.id, details: { submission: sId } });
  res.redirect(back(req, 'forms'));
});

router.post('/patients/:id/forms/:assignmentId/cancel', requireManage, patientParam, async (req, res) => {
  await run("UPDATE form_assignments SET status = 'cancelled' WHERE id = ? AND patient_id = ? AND status = 'assigned'", toInt(req.params.assignmentId), req.patient.id);
  res.redirect(back(req, 'forms'));
});

/* ---------- Care plans ---------- */

const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
function readPlan(body) {
  return { title: text(body.title, 200) || 'Care plan', goals: text(body.goals, 10000), summary: text(body.summary, 20000) };
}

router.post('/patients/:id/plans', requireManage, patientParam, async (req, res) => {
  const c = readPlan(req.body);
  const id = await insert(`INSERT INTO care_plans (patient_id, content_enc, start_date, end_date, review_date, created_by, created_by_name, case_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    req.patient.id, vault.seal(c), dateOrNull(req.body.start_date), dateOrNull(req.body.end_date), dateOrNull(req.body.review_date), res.locals.staff.id, res.locals.staff.name,
    await cases.validFor(req.patient.id, req.body.case_id));
  await audit.record(req, 'patient.plan_created', { entityType: 'patient', entityId: req.patient.id, details: { plan: id } });
  res.redirect(`/admin/clinic/patients/${req.patient.id}?tab=plans&plan=${id}`);
});

async function planParam(req, res, next) {
  const p = await get('SELECT * FROM care_plans WHERE id = ? AND patient_id = ?', toInt(req.params.planId), req.patient.id);
  if (!p) return notFound(res);
  req.plan = p;
  next();
}
const planBack = (req) => `/admin/clinic/patients/${req.patient.id}?tab=plans&plan=${req.plan.id}`;

// Any change to an active, shared plan keeps the previous version.
async function beforePlanChange(req) {
  if (req.plan.status === 'active') {
    await clinic2.snapshotPlan(req.plan.id, res0(req));
    await run('UPDATE care_plans SET version = version + 1, updated_at = now() WHERE id = ?', req.plan.id);
  } else await run('UPDATE care_plans SET updated_at = now() WHERE id = ?', req.plan.id);
}
const res0 = (req) => (req.res.locals.staff ? req.res.locals.staff.name : '');

router.post('/patients/:id/plans/:planId', requireManage, patientParam, planParam, async (req, res) => {
  await beforePlanChange(req);
  const status = ['draft', 'active', 'completed', 'archived'].includes(req.body.status) ? req.body.status : req.plan.status;
  await run('UPDATE care_plans SET content_enc = ?, start_date = ?, end_date = ?, review_date = ?, status = ?, shared_with_patient = ? WHERE id = ?',
    vault.seal(readPlan(req.body)), dateOrNull(req.body.start_date), dateOrNull(req.body.end_date), dateOrNull(req.body.review_date), status, req.body.shared === '1' ? 1 : 0, req.plan.id);
  if (req.body.shared === '1' && !req.plan.shared_with_patient) {
    await comms.send('plan_shared', req.patient, { link: `${comms.base()}/account/clinic` });
  }
  await audit.record(req, 'patient.plan_updated', { entityType: 'patient', entityId: req.patient.id, details: { plan: req.plan.id, status, shared: req.body.shared === '1' } });
  flash(req, 'success', 'Care plan saved.');
  res.redirect(planBack(req));
});

router.post('/patients/:id/plans/:planId/items', requireManage, patientParam, planParam, async (req, res) => {
  const kind = clinic2.ITEM_KEYS.includes(req.body.kind) ? req.body.kind : null;
  const content = {
    title: text(req.body.title, 300), details: text(req.body.details, 10000), dose: text(req.body.dose, 200), frequency: ['daily', 'weekly', 'once', 'as_needed', ''].includes(req.body.frequency) ? req.body.frequency : '',
    timing: text(req.body.timing, 200), duration: text(req.body.duration, 200), preparation: text(req.body.preparation, 5000), cautions: text(req.body.cautions, 5000),
  };
  if (!kind || !content.title) { flash(req, 'error', 'Choose the type and give the item a title.'); return res.redirect(planBack(req)); }
  // Formulas recommended to a patient must be approved first.
  const formulaId = toInt(req.body.formula_id) || null;
  if (formulaId && !(await get("SELECT 1 FROM formulas WHERE id = ? AND status = 'approved'", formulaId))) { flash(req, 'error', 'Only approved formulas can be added to a care plan.'); return res.redirect(planBack(req)); }
  await beforePlanChange(req);
  const pos = ((await get('SELECT MAX(position) AS m FROM care_plan_items WHERE plan_id = ?', req.plan.id)).m ?? -1) + 1;
  const lessonId = toInt(req.body.lesson_id) || null;
  await insert(`INSERT INTO care_plan_items (plan_id, kind, content_enc, formula_id, variant_id, herb_id, lesson_id, is_task, start_date, end_date, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.plan.id, kind, vault.seal(content), formulaId, toInt(req.body.variant_id) || null, toInt(req.body.herb_id) || null,
  lessonId, req.body.is_task === '1' || ['task', 'routine'].includes(kind) ? 1 : 0, dateOrNull(req.body.start_date), dateOrNull(req.body.end_date), pos);
  if (lessonId) await insert('INSERT INTO lesson_assignments (patient_id, lesson_id, care_plan_id, assigned_by) VALUES (?, ?, ?, ?)', req.patient.id, lessonId, req.plan.id, res.locals.staff.name);
  await audit.record(req, 'patient.plan_item_added', { entityType: 'patient', entityId: req.patient.id, details: { plan: req.plan.id, kind } });
  res.redirect(planBack(req));
});

router.post('/patients/:id/plans/:planId/items/:itemId/delete', requireManage, patientParam, planParam, async (req, res) => {
  await beforePlanChange(req);
  await run('DELETE FROM care_plan_items WHERE id = ? AND plan_id = ?', toInt(req.params.itemId), req.plan.id);
  res.redirect(planBack(req));
});

router.get('/patients/:id/plans/:planId/versions/:version', patientParam, planParam, async (req, res) => {
  const v = await get('SELECT * FROM care_plan_versions WHERE plan_id = ? AND version = ?', req.plan.id, toInt(req.params.version));
  if (!v) return notFound(res);
  await audit.record(req, 'patient.plan_version_viewed', { entityType: 'patient', entityId: req.patient.id, details: { plan: req.plan.id, version: v.version } });
  res.render('admin/clinic/plan-version', { title: `Care plan version ${v.version}`, patient: req.patient, plan: req.plan, v, snap: vault.open(v.snapshot_enc) });
});

router.get('/patients/:id/plans/:planId/print', patientParam, planParam, async (req, res) => {
  await audit.record(req, 'patient.plan_printed', { entityType: 'patient', entityId: req.patient.id, details: { plan: req.plan.id } });
  res.render('admin/clinic/plan-print', { title: 'Care plan', patient: req.patient, plan: await clinic2.plan(req.plan.id, req.patient.id) });
});

/* ---------- Progress, learning, messages, note templates ---------- */

router.post('/patients/:id/logs', requireManage, patientParam, async (req, res) => {
  const l = clinic2.readLog({ ...req.body, kind: req.body.kind === 'review' ? 'review' : req.body.kind });
  if (l.empty) { flash(req, 'error', 'Nothing to record.'); return res.redirect(back(req, 'progress')); }
  await insert('INSERT INTO patient_logs (patient_id, kind, log_date, data_enc, by_patient) VALUES (?, ?, ?, ?, 0)', req.patient.id, l.kind, l.date, vault.seal({ ...l.data, by: res.locals.staff.name }));
  await audit.record(req, 'patient.progress_recorded', { entityType: 'patient', entityId: req.patient.id, details: { kind: l.kind } });
  res.redirect(back(req, 'progress'));
});

router.post('/patients/:id/learning', requireManage, patientParam, async (req, res) => {
  const lessonId = toInt(req.body.lesson_id) || null;
  const courseId = toInt(req.body.course_id) || null;
  if (!lessonId && !courseId) { flash(req, 'error', 'Choose a lesson or a course.'); return res.redirect(back(req, 'learning')); }
  await insert('INSERT INTO lesson_assignments (patient_id, lesson_id, course_id, assigned_by, due_at) VALUES (?, ?, ?, ?, ?)', req.patient.id, lessonId, courseId, res.locals.staff.name, dateOrNull(req.body.due_at));
  await audit.record(req, 'patient.lesson_assigned', { entityType: 'patient', entityId: req.patient.id, details: { lesson: lessonId, course: courseId } });
  await comms.send('lesson_assigned', req.patient, { link: `${comms.base()}/account/clinic/learning` });
  flash(req, 'success', 'Assigned. It now appears in the patient\'s learning centre.');
  res.redirect(back(req, 'learning'));
});

router.post('/patients/:id/messages', requireManage, patientParam, async (req, res) => {
  const body = text(req.body.body, 20000);
  if (!body) { flash(req, 'error', 'Write a message.'); return res.redirect(back(req, 'messages')); }
  const tid = toInt(req.body.thread_id) && await get('SELECT 1 FROM message_threads WHERE id = ? AND patient_id = ?', toInt(req.body.thread_id), req.patient.id) ? toInt(req.body.thread_id) : null;
  const threadId = await clinic2.postMessage({ patientId: req.patient.id, threadId: tid, subject: text(req.body.subject, 200), body, sender: 'staff', staff: res.locals.staff });
  await audit.record(req, 'patient.message_sent', { entityType: 'patient', entityId: req.patient.id, details: { thread: threadId } });
  res.redirect(`/admin/clinic/patients/${req.patient.id}?tab=messages&thread=${threadId}`);
});

/* ---------- Cases (episodes of care) ---------- */

const caseBack = (req, id) => `/admin/clinic/patients/${req.patient.id}/cases/${id}`;

router.post('/patients/:id/cases', requireManage, patientParam, async (req, res) => {
  const title = text(req.body.title, 200);
  if (!title) { flash(req, 'error', 'Give the case a short title, e.g. “Sleep and stress”.'); return res.redirect(back(req, 'cases')); }
  const referrer = toInt(req.body.referrer_id) && await get('SELECT id FROM referrers WHERE id = ?', toInt(req.body.referrer_id));
  const id = await insert(`INSERT INTO clinic_cases (patient_id, title, referrer_id, referral_date, practitioner_id, details_enc, opened_on, created_by)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?)`, req.patient.id, title, referrer ? referrer.id : null, dateOrNull(req.body.referral_date),
  res.locals.staff.id, vault.seal({ reason: text(req.body.reason, 10000), goals: text(req.body.goals, 10000) }), dateOrNull(req.body.opened_on), res.locals.staff.name);
  await audit.record(req, 'patient.case_opened', { entityType: 'patient', entityId: req.patient.id, details: { case: id } });
  res.redirect(caseBack(req, id));
});

router.get('/patients/:id/cases/:caseId', patientParam, async (req, res) => {
  const c = await cases.load(req.patient.id, toInt(req.params.caseId));
  if (!c) return notFound(res);
  await audit.record(req, 'patient.case_viewed', { entityType: 'patient', entityId: req.patient.id, details: { case: c.id } });
  res.render('admin/clinic/case', {
    title: `${c.title} · ${req.patient.name}`, patient: req.patient, c, canManage: canManage(res), ymd: clinic.ymd, NOTE_KINDS: clinic.NOTE_KINDS,
    referrers: await all('SELECT id, name, organisation FROM referrers WHERE archived = 0 ORDER BY lower(name)'),
    when: (d) => require('../../scheduling').formatWhen(d),
  });
});

router.post('/patients/:id/cases/:caseId', requireManage, patientParam, async (req, res) => {
  const c = await get('SELECT * FROM clinic_cases WHERE id = ? AND patient_id = ?', toInt(req.params.caseId), req.patient.id);
  if (!c) return notFound(res);
  if (req.body.action === 'close') {
    await run("UPDATE clinic_cases SET status = 'closed', closed_on = CURRENT_DATE, closed_reason = ?, updated_at = now() WHERE id = ?", text(req.body.closed_reason, 300), c.id);
    await audit.record(req, 'patient.case_closed', { entityType: 'patient', entityId: req.patient.id, details: { case: c.id } });
  } else if (req.body.action === 'reopen') {
    await run("UPDATE clinic_cases SET status = 'open', closed_on = NULL, closed_reason = '', updated_at = now() WHERE id = ?", c.id);
  } else {
    const referrer = toInt(req.body.referrer_id) && await get('SELECT id FROM referrers WHERE id = ?', toInt(req.body.referrer_id));
    await run('UPDATE clinic_cases SET title = ?, referrer_id = ?, referral_date = ?, details_enc = ?, updated_at = now() WHERE id = ?',
      text(req.body.title, 200) || c.title, referrer ? referrer.id : null, dateOrNull(req.body.referral_date), vault.seal({ reason: text(req.body.reason, 10000), goals: text(req.body.goals, 10000) }), c.id);
    flash(req, 'success', 'Case saved.');
  }
  res.redirect(caseBack(req, c.id));
});

// Letter to the referrer (or a summary for the client's other practitioners), saved and printable.
router.get('/patients/:id/cases/:caseId/report', patientParam, async (req, res) => {
  const c = await cases.load(req.patient.id, toInt(req.params.caseId));
  if (!c) return notFound(res);
  await audit.record(req, 'patient.case_report_viewed', { entityType: 'patient', entityId: req.patient.id, details: { case: c.id } });
  res.render('admin/clinic/case-report', { title: `Report: ${c.title}`, patient: req.patient, c, canManage: canManage(res), ymd: clinic.ymd, print: req.query.print === '1' });
});

router.post('/patients/:id/cases/:caseId/report', requireManage, patientParam, async (req, res) => {
  const c = await get('SELECT id FROM clinic_cases WHERE id = ? AND patient_id = ?', toInt(req.params.caseId), req.patient.id);
  if (!c) return notFound(res);
  await run('UPDATE clinic_cases SET report_enc = ?, updated_at = now() WHERE id = ?', vault.seal({ body: text(req.body.body, 30000), signed_by: res.locals.staff.name, date: new Date().toISOString().slice(0, 10) }), c.id);
  await audit.record(req, 'patient.case_report_saved', { entityType: 'patient', entityId: req.patient.id, details: { case: c.id } });
  flash(req, 'success', 'Report saved.');
  res.redirect(`${caseBack(req, c.id)}/report`);
});

/* ---------- Referrers ---------- */

router.get('/referrers', async (req, res) => {
  const list = await all(`SELECT r.*, (SELECT COUNT(*) FROM clinic_cases c WHERE c.referrer_id = r.id) AS cases,
      (SELECT MAX(c.referral_date) FROM clinic_cases c WHERE c.referrer_id = r.id) AS last_referral
    FROM referrers r ORDER BY r.archived, lower(r.name)`);
  res.render('admin/clinic/referrers', { title: 'Referrers', list, KINDS: cases.REFERRER_KINDS, canManage: canManage(res), edit: toInt(req.query.edit) });
});

router.post('/referrers', requireManage, async (req, res) => {
  const name = text(req.body.name, 200);
  if (!name) { flash(req, 'error', 'Enter the referrer’s name.'); return res.redirect('/admin/clinic/referrers'); }
  const kind = cases.REFERRER_KINDS.some(([k]) => k === req.body.kind) ? req.body.kind : 'other';
  const fields = [name, text(req.body.organisation, 200), kind, text(req.body.email, 200), text(req.body.phone, 60), text(req.body.address, 500), text(req.body.notes, 2000)];
  const id = toInt(req.body.id);
  if (id) await run('UPDATE referrers SET name = ?, organisation = ?, kind = ?, email = ?, phone = ?, address = ?, notes = ?, archived = ? WHERE id = ?', ...fields, req.body.archived === '1' ? 1 : 0, id);
  else await insert('INSERT INTO referrers (name, organisation, kind, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', ...fields);
  flash(req, 'success', 'Referrer saved.');
  res.redirect('/admin/clinic/referrers');
});

router.post('/note-templates', requireManage, async (req, res) => {
  const name = text(req.body.name, 100);
  if (name) await insert('INSERT INTO note_templates (name, kind, body, owner_id) VALUES (?, ?, ?, ?)', name, clinic.NOTE_KEYS.includes(req.body.kind) ? req.body.kind : 'consultation', text(req.body.body), req.body.shared === '1' ? null : res.locals.staff.id);
  flash(req, 'success', 'Template saved.');
  res.redirect(String(req.body.back || '').startsWith('/admin/clinic/') ? req.body.back : '/admin/clinic/patients');
});

/* ---------- Staff inbox: messages and forms waiting, for patients this person can see ---------- */

router.get('/inbox', async (req, res) => {
  const s = clinic.scope(res.locals.staff);
  const unread = await all(`SELECT t.id, t.patient_id, t.last_message_at, c.first_name, c.last_name, c.email,
      (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.sender_type = 'patient' AND m.read_by_staff_at IS NULL) AS unread
    FROM message_threads t JOIN patients p ON p.id = t.patient_id JOIN customers c ON c.id = p.customer_id
    WHERE ${s.sql} AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.sender_type = 'patient' AND m.read_by_staff_at IS NULL) ORDER BY t.last_message_at DESC`, ...s.params);
  const forms = await all(`SELECT a.id, a.patient_id, f.name, c.first_name, c.last_name, sub.submitted_at FROM form_assignments a JOIN intake_forms f ON f.id = a.form_id
    JOIN patients p ON p.id = a.patient_id JOIN customers c ON c.id = p.customer_id JOIN form_submissions sub ON sub.id = a.submission_id
    WHERE ${s.sql} AND a.status = 'submitted' ORDER BY sub.submitted_at DESC`, ...s.params);
  const reviews = await all(`SELECT cp.id, cp.patient_id, cp.review_date, c.first_name, c.last_name FROM care_plans cp JOIN patients p ON p.id = cp.patient_id JOIN customers c ON c.id = p.customer_id
    WHERE ${s.sql} AND cp.status = 'active' AND cp.review_date IS NOT NULL AND cp.review_date <= CURRENT_DATE + 7 ORDER BY cp.review_date`, ...s.params);
  const drafts = await all(`SELECT n.id, n.patient_id, n.visit_date, n.kind, c.first_name, c.last_name FROM clinical_notes n JOIN patients p ON p.id = n.patient_id JOIN customers c ON c.id = p.customer_id
    WHERE n.author_id = ? AND n.signed_at IS NULL ORDER BY n.visit_date`, res.locals.staff.id);
  res.render('admin/clinic/inbox', { title: 'Clinic inbox', unread, forms, reviews, drafts });
});

module.exports = router;
