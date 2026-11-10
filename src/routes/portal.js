'use strict';
// My Clinic: the patient side of the clinic, inside the customer account. Patients see only their
// own records, and only what has been shared with them (care plans, documents), plus their forms,
// learning, journal and secure messages. Every view and change is audited.
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { get, all, run, insert } = require('../db');
const vault = require('../vault');
const clinic2 = require('../clinic2');
const storage = require('../storage');
const audit = require('../audit');
const { flash, requireCustomer, verifyCsrf } = require('../middleware');
const { toInt, token } = require('../utils');

const router = express.Router();
router.use(requireCustomer);

router.use(async (req, res, next) => {
  if (!vault.configured()) return res.status(503).render('store/404', { title: 'Clinic unavailable', message: 'The clinic area is not available right now.' });
  const p = await get("SELECT * FROM patients WHERE customer_id = ? AND portal_enabled = 1 AND status != 'archived'", res.locals.customer.id);
  if (!p) return res.status(404).render('store/404', { title: 'Not found', message: 'There is no clinic record for your account. Contact us if you think that is wrong.' });
  req.patient = p;
  res.locals.ITEM_KINDS = clinic2.ITEM_KINDS;
  res.locals.ymd = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
  next();
});

const actor = (req) => ({ type: 'customer', id: req.res.locals.customer.id, name: `${req.res.locals.customer.first_name} ${req.res.locals.customer.last_name}`.trim() || req.res.locals.customer.email });
const log = (req, action, details = {}) => audit.record(req, action, { entityType: 'patient', entityId: req.patient.id, actor: actor(req), details });
const text = (v, max = 20000) => String(v || '').trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

router.get('/', async (req, res) => {
  const p = req.patient;
  const [forms, plans, lessons, threads, logs, docs] = await Promise.all([
    all("SELECT a.*, f.name FROM form_assignments a JOIN intake_forms f ON f.id = a.form_id WHERE a.patient_id = ? AND a.status = 'assigned' ORDER BY a.due_at NULLS LAST, a.id", p.id),
    clinic2.plans(p.id, { sharedOnly: true }), clinic2.assignedLessons(p.id), clinic2.threads(p.id), clinic2.logs(p.id, 5),
    all('SELECT id, kind, title_enc, created_at FROM patient_documents WHERE patient_id = ? AND (shared_with_patient = 1 OR uploaded_by_patient = 1) ORDER BY id DESC LIMIT 5', p.id),
  ]);
  const active = plans.find((x) => x.status === 'active');
  const plan = active ? await clinic2.plan(active.id, p.id) : null;
  await log(req, 'portal.viewed');
  res.render('store/clinic/index', {
    title: 'My clinic', forms, plans, plan, lessons, threads, logs, docs: docs.map((d) => ({ ...d, title: vault.open(d.title_enc) })),
    unread: threads.reduce((s, t) => s + Number(t.unread_patient), 0), progress: plan ? clinic2.progress(plan) : null,
  });
});

/* ---------- Forms ---------- */

async function assignmentParam(req, res, next) {
  const a = await get("SELECT a.*, f.name, f.description, f.fields, f.version, f.id AS form_id FROM form_assignments a JOIN intake_forms f ON f.id = a.form_id WHERE a.id = ? AND a.patient_id = ?", toInt(req.params.id), req.patient.id);
  if (!a) return res.status(404).render('store/404', { title: 'Not found' });
  a.fieldList = JSON.parse(a.fields);
  req.assignment = a;
  next();
}

router.get('/forms/:id', assignmentParam, async (req, res) => {
  const a = req.assignment;
  if (a.status !== 'assigned') { flash(req, 'success', 'Thank you — this form has already been sent.'); return res.redirect('/account/clinic'); }
  res.render('store/clinic/form', { title: a.name, a, answers: req.session.formDraft && req.session.formDraft.id === a.id ? req.session.formDraft.answers : {} });
});

const formUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: storage.MAX_BYTES, files: 10 },
  fileFilter: (req, file, cb) => cb(null, storage.PRIVATE_TYPES.has(path.extname(file.originalname).toLowerCase())),
});

router.post('/forms/:id', formUpload.any(), verifyCsrf, assignmentParam, async (req, res) => {
  const a = req.assignment;
  if (a.status !== 'assigned') return res.redirect('/account/clinic');
  // Uploaded files are encrypted into the patient's documents; the answer stores the document id.
  const files = {};
  for (const f of req.files || []) {
    const fieldId = f.fieldname.replace(/^f_/, '');
    if (!a.fieldList.some((x) => x.id === fieldId && x.type === 'file')) continue;
    const ext = path.extname(f.originalname).toLowerCase();
    const key = `patients/${req.patient.id}/${token(16)}`;
    await storage.savePrivate(key, vault.sealBuffer(f.buffer));
    files[fieldId] = await insert(`INSERT INTO patient_documents (patient_id, kind, title_enc, storage_key, mime, size_bytes, uploaded_by_name, uploaded_by_patient)
      VALUES (?, 'intake', ?, ?, ?, ?, 'Patient', 1)`, req.patient.id, vault.seal(`${a.name}: ${f.originalname}`.slice(0, 300)), key, storage.PRIVATE_TYPES.get(ext), f.size);
  }
  const { answers, errors } = clinic2.readAnswers(a.fieldList, req.body, files);
  if (errors.length) {
    req.session.formDraft = { id: a.id, answers };
    flash(req, 'error', errors.join(' '));
    return res.redirect(`/account/clinic/forms/${a.id}`);
  }
  const sig = a.fieldList.find((f) => f.type === 'signature');
  await clinic2.submitForm({ assignment: a, form: { id: a.form_id, version: a.version, fields: a.fields }, patientId: req.patient.id, answers, by: 'patient', signature: sig ? { name: answers[sig.id], at: new Date().toISOString(), ip: req.ip } : null });
  delete req.session.formDraft;
  await log(req, 'portal.form_submitted', { assignment: a.id });
  flash(req, 'success', 'Thank you. Your form was sent securely to the clinic.');
  res.redirect('/account/clinic');
});

/* ---------- Care plans ---------- */

async function planParam(req, res, next) {
  const p = await get("SELECT id FROM care_plans WHERE id = ? AND patient_id = ? AND shared_with_patient = 1 AND status IN ('active', 'completed')", toInt(req.params.id), req.patient.id);
  if (!p) return res.status(404).render('store/404', { title: 'Not found' });
  req.plan = await clinic2.plan(p.id, req.patient.id);
  next();
}

router.get('/plans/:id', planParam, async (req, res) => {
  await log(req, 'portal.plan_viewed', { plan: req.plan.id });
  res.render('store/clinic/plan', { title: req.plan.content.title || 'My care plan', plan: req.plan, progress: clinic2.progress(req.plan) });
});

router.post('/plans/:id/items/:itemId/done', planParam, async (req, res) => {
  const item = req.plan.items.find((i) => i.id === toInt(req.params.itemId) && i.is_task);
  if (item) {
    if (item.doneToday) await run('DELETE FROM care_plan_completions WHERE item_id = ? AND done_on = ?', item.id, today());
    else await run('INSERT INTO care_plan_completions (item_id, done_on) VALUES (?, ?) ON CONFLICT DO NOTHING', item.id, today());
  }
  res.redirect(String(req.body.back || '').startsWith('/account/clinic') ? req.body.back : `/account/clinic/plans/${req.plan.id}`);
});

// Buying a recommended product from the plan puts it in the normal store cart.
router.post('/plans/:id/items/:itemId/cart', planParam, async (req, res) => {
  const item = req.plan.items.find((i) => i.id === toInt(req.params.itemId) && i.variant_id);
  if (!item || item.product_status !== 'active') { flash(req, 'error', 'That product is not available right now.'); return res.redirect(`/account/clinic/plans/${req.plan.id}`); }
  const cart = req.session.cart || [];
  const line = cart.find((l) => l.variant_id === item.variant_id);
  if (line) line.quantity += 1; else cart.push({ variant_id: item.variant_id, quantity: 1 });
  req.session.cart = cart;
  flash(req, 'success', 'Added to your cart.');
  res.redirect('/cart');
});

/* ---------- Learning ---------- */

router.get('/learning', async (req, res) => res.render('store/clinic/learning', { title: 'My learning', lessons: await clinic2.assignedLessons(req.patient.id) }));

router.get('/learning/:lessonId', async (req, res) => {
  const id = toInt(req.params.lessonId);
  if (!await clinic2.canSeeLesson(req.patient.id, id)) return res.status(404).render('store/404', { title: 'Not found' });
  const lesson = await get("SELECT * FROM lessons WHERE id = ? AND status = 'published'", id);
  if (!lesson) return res.status(404).render('store/404', { title: 'Not found' });
  const questions = (await all('SELECT id, question, options FROM lesson_questions WHERE lesson_id = ? ORDER BY position', id)).map((q) => ({ ...q, options: JSON.parse(q.options) }));
  await run('INSERT INTO lesson_progress (patient_id, lesson_id, acknowledged_at) VALUES (?, ?, now()) ON CONFLICT (patient_id, lesson_id) DO UPDATE SET acknowledged_at = COALESCE(lesson_progress.acknowledged_at, now())', req.patient.id, id);
  const progress = await get('SELECT * FROM lesson_progress WHERE patient_id = ? AND lesson_id = ?', req.patient.id, id);
  res.render('store/clinic/lesson', { title: lesson.title, lesson, questions, progress });
});

router.post('/learning/:lessonId/complete', async (req, res) => {
  const id = toInt(req.params.lessonId);
  if (!await clinic2.canSeeLesson(req.patient.id, id)) return res.status(404).render('store/404', { title: 'Not found' });
  let score = null;
  let total = null;
  const questions = await all('SELECT id, correct_index FROM lesson_questions WHERE lesson_id = ?', id);
  if (questions.length) {
    total = questions.length;
    score = questions.filter((q) => toInt(req.body[`q_${q.id}`], -1) === q.correct_index).length;
  }
  await run(`INSERT INTO lesson_progress (patient_id, lesson_id, completed_at, acknowledged_at, quiz_score, quiz_total) VALUES (?, ?, now(), now(), ?, ?)
    ON CONFLICT (patient_id, lesson_id) DO UPDATE SET completed_at = now(), quiz_score = EXCLUDED.quiz_score, quiz_total = EXCLUDED.quiz_total`, req.patient.id, id, score, total);
  await log(req, 'portal.lesson_completed', { lesson: id });
  flash(req, 'success', total ? `Lesson complete — you got ${score} of ${total}.` : 'Lesson marked complete.');
  res.redirect(`/account/clinic/learning/${id}`);
});

/* ---------- Wellness journal ---------- */

router.get('/journal', async (req, res) => {
  const logs = await clinic2.logs(req.patient.id, 60);
  res.render('store/clinic/journal', { title: 'My wellness', logs: logs.filter((l) => l.by_patient), series: clinic2.series(logs.filter((l) => l.by_patient)) });
});

router.post('/journal', async (req, res) => {
  const l = clinic2.readLog({ ...req.body, kind: ['journal', 'symptom', 'wellness'].includes(req.body.kind) ? req.body.kind : 'journal' });
  if (l.empty) { flash(req, 'error', 'Add a note or a score.'); return res.redirect('/account/clinic/journal'); }
  await insert('INSERT INTO patient_logs (patient_id, kind, log_date, data_enc, by_patient) VALUES (?, ?, ?, ?, 1)', req.patient.id, l.kind, l.date, vault.seal(l.data));
  await log(req, 'portal.journal_added', { kind: l.kind });
  flash(req, 'success', 'Saved.');
  res.redirect('/account/clinic/journal');
});

/* ---------- Messages ---------- */

router.get('/messages', async (req, res) => {
  const threads = await clinic2.threads(req.patient.id);
  const tid = toInt(req.query.thread) || (threads[0] && threads[0].id);
  const thread = tid ? await clinic2.thread(tid, req.patient.id) : null;
  if (thread) await run("UPDATE messages SET read_by_patient_at = now() WHERE thread_id = ? AND sender_type = 'staff' AND read_by_patient_at IS NULL", thread.id);
  await log(req, 'portal.messages_viewed', { thread: thread ? thread.id : null });
  res.render('store/clinic/messages', { title: 'Messages', threads, thread });
});

router.post('/messages', async (req, res) => {
  const body = text(req.body.body);
  if (!body) { flash(req, 'error', 'Write a message.'); return res.redirect('/account/clinic/messages'); }
  const tid = toInt(req.body.thread_id) && await get('SELECT 1 FROM message_threads WHERE id = ? AND patient_id = ?', toInt(req.body.thread_id), req.patient.id) ? toInt(req.body.thread_id) : null;
  const threadId = await clinic2.postMessage({ patientId: req.patient.id, threadId: tid, subject: text(req.body.subject, 200) || 'Message', body, sender: 'patient' });
  await log(req, 'portal.message_sent', { thread: threadId });
  flash(req, 'success', 'Message sent securely.');
  res.redirect(`/account/clinic/messages?thread=${threadId}`);
});

/* ---------- Documents ---------- */

router.get('/documents', async (req, res) => {
  const docs = (await all('SELECT id, kind, title_enc, mime, size_bytes, created_at, uploaded_by_patient FROM patient_documents WHERE patient_id = ? AND (shared_with_patient = 1 OR uploaded_by_patient = 1) ORDER BY id DESC', req.patient.id))
    .map((d) => ({ ...d, title: vault.open(d.title_enc) }));
  res.render('store/clinic/documents', { title: 'My documents', docs });
});

router.get('/documents/:id', async (req, res) => {
  const d = await get('SELECT * FROM patient_documents WHERE id = ? AND patient_id = ? AND (shared_with_patient = 1 OR uploaded_by_patient = 1)', toInt(req.params.id), req.patient.id);
  if (!d) return res.status(404).render('store/404', { title: 'Not found' });
  const body = vault.openBuffer(await storage.readPrivate(d.storage_key));
  await log(req, 'portal.document_viewed', { document: d.id });
  res.set({ 'Content-Type': d.mime, 'Content-Disposition': `attachment; filename="${(vault.open(d.title_enc) || 'document').replace(/[^\w.\- ]+/g, '_')}"`, 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(body);
});

router.post('/documents', storage.privateUpload.single('file'), verifyCsrf, async (req, res) => {
  if (!req.file) { flash(req, 'error', 'Choose a PDF, photo, Word or text file up to 4 MB.'); return res.redirect('/account/clinic/documents'); }
  const ext = path.extname(req.file.originalname).toLowerCase();
  const key = `patients/${req.patient.id}/${token(16)}`;
  await storage.savePrivate(key, vault.sealBuffer(req.file.buffer));
  const kind = ['lab_result', 'photo', 'document'].includes(req.body.kind) ? req.body.kind : 'document';
  await insert(`INSERT INTO patient_documents (patient_id, kind, title_enc, storage_key, mime, size_bytes, uploaded_by_name, uploaded_by_patient) VALUES (?, ?, ?, ?, ?, ?, 'Patient', 1)`,
    req.patient.id, kind, vault.seal(text(req.body.title, 300) || req.file.originalname.slice(0, 300)), key, storage.PRIVATE_TYPES.get(ext), req.file.size);
  await log(req, 'portal.document_uploaded', { kind });
  flash(req, 'success', 'Uploaded securely. Your practitioner can now see it.');
  res.redirect('/account/clinic/documents');
});

module.exports = router;
