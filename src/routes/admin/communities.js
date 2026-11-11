'use strict';
// Community spaces (staff side): create groups, invite clients, facilitate and moderate.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const clinic = require('../../clinic');
const communities = require('../../communities');
const comms = require('../../comms');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt } = require('../../utils');

const router = express.Router();
const text = (v, max = 5000) => String(v || '').trim().slice(0, max);

// Running a community needs clinic access (members are clients) and education or record permissions.
router.use((req, res, next) => {
  const can = res.locals.can;
  if (!clinic.canSeeAny(res.locals.staff) || !(can('education.manage') || can('clinic.records.manage'))) {
    return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include community spaces.' });
  }
  next();
});

router.get('/', async (req, res) => {
  const list = await all(`SELECT c.*, s.name AS facilitator_name, co.title AS course_title,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id AND m.removed_at IS NULL AND m.accepted_at IS NOT NULL) AS members,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id AND m.removed_at IS NULL AND m.accepted_at IS NULL) AS invited,
      (SELECT MAX(p.created_at) FROM community_posts p WHERE p.community_id = c.id) AS last_post,
      (SELECT COUNT(*) FROM community_posts p WHERE p.community_id = c.id AND p.reported_at IS NOT NULL AND p.hidden = 0) AS reported
    FROM communities c LEFT JOIN staff s ON s.id = c.facilitator_id LEFT JOIN courses co ON co.id = c.course_id ORDER BY c.status = 'archived', c.name`);
  res.render('admin/communities/index', { title: 'Communities', list, courses: await all("SELECT id, title FROM courses WHERE status != 'archived' ORDER BY title"), DEFAULT_GUIDELINES: communities.DEFAULT_GUIDELINES });
});

router.post('/', async (req, res) => {
  const name = text(req.body.name, 150);
  if (!name) { flash(req, 'error', 'Give the community a name.'); return res.redirect('/admin/communities'); }
  const course = toInt(req.body.course_id) && await get('SELECT id FROM courses WHERE id = ?', toInt(req.body.course_id));
  const id = await insert('INSERT INTO communities (name, description, guidelines, course_id, facilitator_id) VALUES (?, ?, ?, ?, ?)',
    name, text(req.body.description, 2000), text(req.body.guidelines) || communities.DEFAULT_GUIDELINES, course ? course.id : null, res.locals.staff.id);
  await audit.record(req, 'community.created', { entityType: 'community', entityId: id });
  res.redirect(`/admin/communities/${id}`);
});

async function communityParam(req, res, next) {
  const c = await get('SELECT * FROM communities WHERE id = ?', toInt(req.params.id));
  if (!c) return res.status(404).render('admin/error', { title: 'Not found', message: 'This community does not exist.' });
  req.community = c;
  next();
}

router.get('/:id', communityParam, async (req, res) => {
  const c = req.community;
  const s = clinic.scope(res.locals.staff);
  const members = await all(`SELECT m.*, cu.first_name, cu.last_name, cu.email FROM community_members m JOIN patients p ON p.id = m.patient_id JOIN customers cu ON cu.id = p.customer_id
    WHERE m.community_id = ? ORDER BY m.removed_at IS NOT NULL, m.accepted_at IS NULL, lower(cu.first_name)`, c.id);
  // Only clients this person can see may be invited.
  const invitable = await all(`SELECT p.id, cu.first_name, cu.last_name, cu.email FROM patients p JOIN customers cu ON cu.id = p.customer_id
    WHERE ${s.sql} AND p.status = 'active' AND NOT EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = ? AND m.patient_id = p.id AND m.removed_at IS NULL)
    ORDER BY lower(cu.first_name) LIMIT 500`, ...s.params, c.id);
  const threads = await communities.feed(c.id, { includeHidden: true });
  await audit.record(req, 'community.viewed', { entityType: 'community', entityId: c.id });
  res.render('admin/communities/show', { title: c.name, c, members, invitable, threads, courses: await all("SELECT id, title FROM courses WHERE status != 'archived' ORDER BY title") });
});

router.post('/:id', communityParam, async (req, res) => {
  const c = req.community;
  const status = ['active', 'read_only', 'archived'].includes(req.body.status) ? req.body.status : c.status;
  const course = toInt(req.body.course_id) && await get('SELECT id FROM courses WHERE id = ?', toInt(req.body.course_id));
  await run('UPDATE communities SET name = ?, description = ?, guidelines = ?, status = ?, course_id = ? WHERE id = ?',
    text(req.body.name, 150) || c.name, text(req.body.description, 2000), text(req.body.guidelines) || c.guidelines, status, course ? course.id : null, c.id);
  flash(req, 'success', 'Community saved.');
  res.redirect(`/admin/communities/${c.id}`);
});

router.post('/:id/invite', communityParam, async (req, res) => {
  const c = req.community;
  let invited = 0;
  for (const pid of [].concat(req.body.patient_id || []).flatMap((x) => String(x).split(',')).map(toInt).filter(Boolean)) {
    const p = await clinic.findVisible(res.locals.staff, pid);
    if (!p) continue;
    await run(`INSERT INTO community_members (community_id, patient_id, display_name, invited_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (community_id, patient_id) DO UPDATE SET removed_at = NULL, invited_at = now(), invited_by = EXCLUDED.invited_by`, c.id, p.id, communities.defaultName(p), res.locals.staff.name);
    // The email names the group only — never anything about the client's health.
    await comms.send('community_invite', p, { community: c.name, link: `${comms.base()}/account/clinic/community/${c.id}` });
    invited++;
  }
  await audit.record(req, 'community.invited', { entityType: 'community', entityId: c.id, details: { count: invited } });
  flash(req, 'success', `${invited} client(s) invited.`);
  res.redirect(`/admin/communities/${c.id}`);
});

router.post('/:id/members/:memberId', communityParam, async (req, res) => {
  const m = await get('SELECT * FROM community_members WHERE id = ? AND community_id = ?', toInt(req.params.memberId), req.community.id);
  if (m) {
    if (req.body.action === 'remove') await run('UPDATE community_members SET removed_at = now() WHERE id = ?', m.id);
    if (req.body.action === 'mute') await run('UPDATE community_members SET muted = 1 - muted WHERE id = ?', m.id);
    await audit.record(req, `community.member_${req.body.action}`, { entityType: 'community', entityId: req.community.id, details: { member: m.id } });
  }
  res.redirect(`/admin/communities/${req.community.id}`);
});

router.post('/:id/posts', communityParam, async (req, res) => {
  const name = `${res.locals.staff.name} (facilitator)`;
  const id = await communities.post({ communityId: req.community.id, parentId: toInt(req.body.parent_id) || null, staffId: res.locals.staff.id, authorName: name, text: req.body.body });
  if (id && req.body.pin === '1') await run('UPDATE community_posts SET pinned = 1 WHERE id = ?', id);
  res.redirect(`/admin/communities/${req.community.id}#post-${id || ''}`);
});

router.post('/:id/posts/:postId', communityParam, async (req, res) => {
  const p = await get('SELECT * FROM community_posts WHERE id = ? AND community_id = ?', toInt(req.params.postId), req.community.id);
  if (p) {
    if (req.body.action === 'pin') await run('UPDATE community_posts SET pinned = 1 - pinned WHERE id = ?', p.id);
    if (req.body.action === 'hide') await run('UPDATE community_posts SET hidden = 1, hidden_reason = ? WHERE id = ?', text(req.body.reason, 200), p.id);
    if (req.body.action === 'unhide') await run("UPDATE community_posts SET hidden = 0, hidden_reason = '', reported_at = NULL WHERE id = ?", p.id);
    if (req.body.action === 'dismiss') await run('UPDATE community_posts SET reported_at = NULL WHERE id = ?', p.id);
    await audit.record(req, `community.post_${req.body.action}`, { entityType: 'community', entityId: req.community.id, details: { post: p.id } });
  }
  res.redirect(`/admin/communities/${req.community.id}#post-${p ? p.id : ''}`);
});

module.exports = router;
