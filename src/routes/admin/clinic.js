'use strict';
// Clinic → Patients. Every route here goes through clinic.findVisible(), which applies the
// assignment rule, and every view or change of a record is written to the audit log (without any
// clinical content). Clinical text and files are encrypted with vault.js before storage.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const clinic = require('../../clinic');
const vault = require('../../vault');
const audit = require('../../audit');
const storage = require('../../storage');
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
    DOCUMENT_KINDS: clinic.DOCUMENT_KINDS, age: clinic.age, ymd: clinic.ymd,
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

const TABS = ['overview', 'health', 'notes', 'documents', 'timeline'];

router.get('/patients/:id', patientParam, async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'overview';
  const p = req.patient;
  const [health, notes, documents, practitioners] = await Promise.all([
    clinic.healthItems(p.id), clinic.notes(p.id), clinic.documents(p.id), clinic.practitioners(p.id),
  ]);
  const extra = {};
  if (tab === 'timeline') extra.events = await clinic.timeline(p);
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
  const id = await insert(`INSERT INTO clinical_notes (patient_id, author_id, author_name, kind, visit_date, body_enc, internal, amends_note_id, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ${sign ? 'now()' : 'NULL'})`, req.patient.id, res.locals.staff.id, res.locals.staff.name, n.kind, n.visit,
  vault.seal(n.content), amendsOk ? amends : null);
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

module.exports = router;
