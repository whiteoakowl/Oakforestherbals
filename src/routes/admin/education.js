'use strict';
// Education → lessons, information sheets, guides, videos, quizzes and courses. Content here is
// general (not about a patient); assigning it to patients happens from the patient's record.
const express = require('express');
const path = require('node:path');
const { get, all, run, insert, tx } = require('../../db');
const clinic2 = require('../../clinic2');
const storage = require('../../storage');
const audit = require('../../audit');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, asList } = require('../../utils');

const router = express.Router();
const KIND_KEYS = clinic2.LESSON_KINDS.map(([k]) => k);
const text = (v, max = 200000) => String(v || '').trim().slice(0, max);

router.use((req, res, next) => { res.locals.LESSON_KINDS = clinic2.LESSON_KINDS; next(); });

// Embeds only from known video hosts, as a privacy-friendly embed URL.
function embedUrl(url) {
  const u = String(url || '').trim();
  let m = u.match(/^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = u.match(/^https:\/\/(?:www\.)?vimeo\.com\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return '';
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lessons = await all(`SELECT l.*, (SELECT COUNT(DISTINCT a.patient_id) FROM lesson_assignments a WHERE a.lesson_id = l.id) AS assigned
    FROM lessons l WHERE (? = '' OR l.title ILIKE ? OR l.category ILIKE ?) ORDER BY l.status = 'archived', lower(l.title)`, q, `%${q}%`, `%${q}%`);
  const courses = await all('SELECT c.*, (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS lessons FROM courses c ORDER BY lower(c.title)');
  res.render('admin/education/index', { title: 'Education', lessons, courses, q });
});

router.get('/lessons/new', async (req, res) => res.render('admin/education/lesson-edit', { title: 'New lesson', lesson: null, questions: [], herbs: await all("SELECT id, common_name FROM herbs WHERE status = 'published' ORDER BY lower(common_name)") }));

async function saveLesson(id, req) {
  const b = req.body;
  const kind = KIND_KEYS.includes(b.kind) ? b.kind : 'lesson';
  const status = ['draft', 'published', 'archived'].includes(b.status) ? b.status : 'draft';
  const video = embedUrl(b.video_url);
  if (b.video_url && !video) throw Object.assign(new Error('Videos can be embedded from YouTube or Vimeo links.'), { status: 422 });
  let fileUrl = null;
  let fileName = null;
  if (req.file) {
    fileUrl = await storage.saveFile(req.file);
    fileName = req.file.originalname.slice(0, 200);
  }
  const cols = [text(b.title, 200), kind, text(b.category, 100), text(b.summary, 2000), text(b.body_html), video, toInt(b.herb_id) || null, status];
  return tx(async () => {
    if (id) {
      await run('UPDATE lessons SET title = ?, kind = ?, category = ?, summary = ?, body_html = ?, video_url = ?, herb_id = ?, status = ?, updated_at = now() WHERE id = ?', ...cols, id);
    } else id = await insert('INSERT INTO lessons (title, kind, category, summary, body_html, video_url, herb_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...cols, req.res.locals.staff.name);
    if (fileUrl) await run('UPDATE lessons SET file_url = ?, file_name = ? WHERE id = ?', fileUrl, fileName, id);
    if (b.remove_file === '1') await run("UPDATE lessons SET file_url = '', file_name = '' WHERE id = ?", id);
    await run('DELETE FROM lesson_questions WHERE lesson_id = ?', id);
    for (const [i, q] of asList(b.questions).entries()) {
      const question = text(q && q.question, 500);
      const options = String((q && q.options) || '').split(/\r?\n/).map((o) => o.trim()).filter(Boolean).slice(0, 8);
      const correct = toInt(q && q.correct, 1) - 1;
      if (question && options.length >= 2 && correct >= 0 && correct < options.length) {
        await run('INSERT INTO lesson_questions (lesson_id, question, options, correct_index, position) VALUES (?, ?, ?, ?, ?)', id, question, JSON.stringify(options), correct, i);
      }
    }
    return id;
  });
}

// Lesson files (PDF guides, Word documents, images) are general handouts, stored like other media.
const lessonUpload = require('multer')({
  storage: require('multer').memoryStorage(), limits: { fileSize: storage.MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file.originalname).toLowerCase())),
});

router.post('/lessons/new', lessonUpload.single('file'), verifyCsrf, async (req, res) => {
  if (!text(req.body.title)) { flash(req, 'error', 'Give the lesson a title.'); return res.redirect('/admin/education/lessons/new'); }
  try {
    const id = await saveLesson(null, req);
    flash(req, 'success', 'Lesson saved.');
    res.redirect(`/admin/education/lessons/${id}`);
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
    res.redirect('/admin/education/lessons/new');
  }
});

router.get('/lessons/:id', async (req, res, next) => {
  const lesson = await get('SELECT * FROM lessons WHERE id = ?', toInt(req.params.id));
  if (!lesson) return next();
  const questions = (await all('SELECT * FROM lesson_questions WHERE lesson_id = ? ORDER BY position', lesson.id)).map((q) => ({ ...q, options: JSON.parse(q.options) }));
  res.render('admin/education/lesson-edit', { title: lesson.title, lesson, questions, herbs: await all("SELECT id, common_name FROM herbs WHERE status = 'published' ORDER BY lower(common_name)") });
});

router.post('/lessons/:id', lessonUpload.single('file'), verifyCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  try {
    await saveLesson(id, req);
    await audit.record(req, 'lesson.updated', { entityType: 'lesson', entityId: id });
    flash(req, 'success', 'Lesson saved.');
  } catch (e) {
    if (!e.status) throw e;
    flash(req, 'error', e.message);
  }
  res.redirect(`/admin/education/lessons/${id}`);
});

router.post('/courses', async (req, res) => {
  const title = text(req.body.title, 200);
  if (!title) { flash(req, 'error', 'Give the course a title.'); return res.redirect('/admin/education'); }
  const id = await insert('INSERT INTO courses (title, description, category) VALUES (?, ?, ?)', title, text(req.body.description, 2000), text(req.body.category, 100));
  res.redirect(`/admin/education/courses/${id}`);
});

router.get('/courses/:id', async (req, res, next) => {
  const course = await get('SELECT * FROM courses WHERE id = ?', toInt(req.params.id));
  if (!course) return next();
  const lessons = await all('SELECT l.*, cl.position FROM course_lessons cl JOIN lessons l ON l.id = cl.lesson_id WHERE cl.course_id = ? ORDER BY cl.position', course.id);
  const available = await all("SELECT id, title FROM lessons WHERE status != 'archived' AND id NOT IN (SELECT lesson_id FROM course_lessons WHERE course_id = ?) ORDER BY lower(title)", course.id);
  res.render('admin/education/course', { title: course.title, course, lessons, available });
});

router.post('/courses/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const status = ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : 'draft';
  await run('UPDATE courses SET title = ?, description = ?, category = ?, status = ? WHERE id = ?', text(req.body.title, 200) || 'Course', text(req.body.description, 2000), text(req.body.category, 100), status, id);
  const add = toInt(req.body.add_lesson_id);
  if (add) await run('INSERT INTO course_lessons (course_id, lesson_id, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM course_lessons WHERE course_id = ?)) ON CONFLICT DO NOTHING', id, add, id);
  const remove = toInt(req.body.remove_lesson_id);
  if (remove) await run('DELETE FROM course_lessons WHERE course_id = ? AND lesson_id = ?', id, remove);
  flash(req, 'success', 'Course saved.');
  res.redirect(`/admin/education/courses/${id}`);
});

module.exports = router;
module.exports.embedUrl = embedUrl;
