'use strict';
// Settings → Roles and permissions, and Settings → Audit log.
const express = require('express');
const { get, all, run } = require('../../db');
const permissions = require('../../permissions');
const audit = require('../../audit');
const { flash, requirePermission } = require('../../middleware');
const { toInt, paginate, slugify } = require('../../utils');

const router = express.Router();

const settingsSections = (res) => require('./settings').sectionsFor(res);

router.use(['/roles', '/audit'], (req, res, next) => {
  res.locals.SECTIONS = settingsSections(res);
  next();
});

/* ---------- Roles ---------- */

router.use('/roles', requirePermission('staff.manage'));

router.get('/roles', async (req, res) => {
  res.render('admin/settings/roles', { title: 'Roles and permissions', roles: await permissions.listRoles() });
});

router.post('/roles', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const key = slugify(name).replace(/-/g, '_');
  if (!name || !key) {
    flash(req, 'error', 'Give the role a name.');
    return res.redirect('/admin/settings/roles');
  }
  if (await get('SELECT 1 FROM roles WHERE key = ?', key)) {
    flash(req, 'error', 'A role with that name already exists.');
    return res.redirect('/admin/settings/roles');
  }
  const id = await permissions.createRole({ key, name, description: String(req.body.description || '').trim() });
  await audit.record(req, 'role.created', { entityType: 'role', entityId: key, details: { name } });
  flash(req, 'success', `Role "${name}" created. Choose its permissions below.`);
  res.redirect(`/admin/settings/roles/${id}`);
});

async function editableRole(req, res) {
  const role = await get('SELECT * FROM roles WHERE id = ?', toInt(req.params.id));
  if (!role) return null;
  role.permissions = [...await permissions.forRole(role.key)];
  return role;
}

router.get('/roles/:id', async (req, res, next) => {
  const role = await editableRole(req, res);
  if (!role) return next();
  const members = await all('SELECT id, name, email FROM staff WHERE role = ? ORDER BY name', role.key);
  res.render('admin/settings/role-edit', { title: role.name, role, members, groups: permissions.catalog() });
});

router.post('/roles/:id', async (req, res, next) => {
  const role = await editableRole(req, res);
  if (!role) return next();
  if (role.key === 'owner') {
    flash(req, 'error', 'The owner role always has every permission.');
    return res.redirect(`/admin/settings/roles/${role.id}`);
  }
  const wanted = [].concat(req.body.permissions || []);
  // Nobody can hand out a permission they don't hold themselves.
  const mine = res.locals.staff.permissions;
  const blocked = wanted.filter((k) => !mine.has(k) && !role.permissions.includes(k));
  if (blocked.length) {
    flash(req, 'error', 'You can only grant permissions your own role has.');
    return res.redirect(`/admin/settings/roles/${role.id}`);
  }
  // Editing your own role could lock you out of this screen.
  if (role.key === res.locals.staff.role && !wanted.includes('staff.manage')) {
    flash(req, 'error', 'You cannot remove "Manage staff accounts and roles" from your own role.');
    return res.redirect(`/admin/settings/roles/${role.id}`);
  }
  const name = String(req.body.name || role.name).trim() || role.name;
  const description = String(req.body.description ?? role.description).trim();
  await run('UPDATE roles SET name = ?, description = ? WHERE id = ?', name, description, role.id);
  // Permissions the editor doesn't hold are shown disabled and never posted; keep them as they were.
  const untouchable = role.permissions.filter((k) => !mine.has(k));
  const saved = await permissions.setRolePermissions(role.id, [...wanted, ...untouchable]);
  const before = new Set(role.permissions);
  await audit.record(req, 'role.updated', {
    entityType: 'role',
    entityId: role.key,
    details: { granted: saved.filter((k) => !before.has(k)), revoked: role.permissions.filter((k) => !saved.includes(k)) },
  });
  flash(req, 'success', 'Role saved. People with this role get the change on their next page load.');
  res.redirect(`/admin/settings/roles/${role.id}`);
});

router.post('/roles/:id/delete', async (req, res, next) => {
  const role = await get('SELECT * FROM roles WHERE id = ?', toInt(req.params.id));
  if (!role) return next();
  const members = (await get('SELECT COUNT(*) AS n FROM staff WHERE role = ?', role.key)).n;
  if (role.is_system) flash(req, 'error', 'Built-in roles can be edited but not deleted.');
  else if (members) flash(req, 'error', `Move the ${members} staff member(s) with this role to another role first.`);
  else {
    await run('DELETE FROM roles WHERE id = ?', role.id);
    await audit.record(req, 'role.deleted', { entityType: 'role', entityId: role.key, details: { name: role.name } });
    flash(req, 'success', `Role "${role.name}" deleted.`);
    return res.redirect('/admin/settings/roles');
  }
  res.redirect(`/admin/settings/roles/${role.id}`);
});

/* ---------- Audit log ---------- */

router.get('/audit', requirePermission('audit.view'), async (req, res) => {
  const where = ['1 = 1'];
  const params = [];
  const q = String(req.query.q || '').trim();
  const action = String(req.query.action || '').trim();
  if (q) { where.push('(actor_name ILIKE ? OR details ILIKE ? OR entity_id = ?)'); params.push(`%${q}%`, `%${q}%`, q); }
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  const total = (await get(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where.join(' AND ')}`, ...params)).n;
  const pager = paginate(total, req.query.page, 50);
  const entries = await all(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pager.perPage, pager.offset);
  const actions = (await all('SELECT DISTINCT split_part(action, \'.\', 1) AS a FROM audit_logs ORDER BY a')).map((r) => r.a);
  for (const e of entries) {
    try { e.details = JSON.parse(e.details || '{}'); } catch { e.details = {}; }
  }
  res.render('admin/settings/audit', { title: 'Audit log', entries, pager, q, action, actions });
});

module.exports = router;
