'use strict';
// Role-based access control. The permission catalog lives in code; which role holds which
// permission lives in the database (roles, role_permissions) so the owner can customise it.
// Enforcement is server-side: every admin router is gated in routes/admin/index.js, and
// views use res.locals.can() only to hide links the server would refuse anyway.
const { get, all, run, insert, tx } = require('./db');

// [key, module, label, sensitive]. Sensitive permissions (clinical records, later phases) are
// never granted to a role by default except where listed explicitly in ROLE_DEFAULTS.
const PERMISSIONS = [
  ['analytics.view', 'Store', 'View sales, revenue and analytics', 0],
  ['orders.view', 'Store', 'View orders', 0],
  ['orders.manage', 'Store', 'Create, edit, fulfill, refund and cancel orders', 0],
  ['products.manage', 'Store', 'Manage products, collections and stock levels', 0],
  ['customers.view', 'Store', 'View customers', 0],
  ['customers.manage', 'Store', 'Create, edit and delete customers', 0],
  ['discounts.manage', 'Store', 'Manage discount codes', 0],
  ['content.manage', 'Online store', 'Manage pages, blog posts, files and navigation', 0],
  ['themes.manage', 'Online store', 'Edit the storefront theme', 0],
  ['settings.manage', 'Administration', 'Store settings: payments, checkout, shipping, taxes, notifications, policies, preferences', 0],
  ['staff.manage', 'Administration', 'Manage staff accounts and roles', 0],
  ['audit.view', 'Administration', 'View the audit log', 0],
];

const STORE_ALL = ['analytics.view', 'orders.view', 'orders.manage', 'products.manage', 'customers.view', 'customers.manage',
  'discounts.manage', 'content.manage', 'themes.manage'];

// System roles and the permissions they start with. Permissions added in later releases are
// granted to these roles once, when they first appear; after that the owner's edits stand.
const ROLE_DEFAULTS = {
  staff: STORE_ALL, // the pre-RBAC "staff" role: everything except settings
  administrator: [...STORE_ALL, 'settings.manage', 'staff.manage', 'audit.view'],
  clinic_manager: [],
  practitioner: [],
  apothecary_manager: [],
  inventory_manager: ['products.manage'],
  store_manager: STORE_ALL,
  customer_service: ['orders.view', 'orders.manage', 'customers.view', 'customers.manage'],
};

const SYSTEM_ROLES = [
  ['administrator', 'Administrator', 'Manages every module and staff. Cannot grant ownership.'],
  ['clinic_manager', 'Clinic manager', 'Runs the clinic: scheduling, patients and practitioners (clinic modules arrive in a later phase).'],
  ['practitioner', 'Herbalist / Practitioner', 'Sees only their assigned patients (clinic modules arrive in a later phase).'],
  ['apothecary_manager', 'Apothecary manager', 'Formulas, production and apothecary inventory (arrive in a later phase).'],
  ['inventory_manager', 'Inventory manager', 'Stock levels and, later, raw materials and suppliers.'],
  ['store_manager', 'Store manager', 'Products, orders, customers, discounts and the online store.'],
  ['customer_service', 'Customer service', 'Handles orders and customer records.'],
];

const KEYS = new Set(PERMISSIONS.map(([k]) => k));

// Brings the catalog and system roles up to date. Safe to run concurrently and on every boot.
async function sync() {
  await tx(async () => {
    await get('SELECT pg_advisory_xact_lock(72002)');
    const existing = new Set((await all('SELECT key FROM permissions')).map((r) => r.key));
    for (const [key, module, label, sensitive] of PERMISSIONS) {
      await run(`INSERT INTO permissions (key, module, label, sensitive) VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, label = EXCLUDED.label, sensitive = EXCLUDED.sensitive`,
      key, module, label, sensitive);
    }
    const added = PERMISSIONS.map(([k]) => k).filter((k) => !existing.has(k));
    for (const [key, name, description] of SYSTEM_ROLES) {
      if (!await get('SELECT 1 FROM roles WHERE key = ?', key)) {
        await run('INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 1) ON CONFLICT (key) DO NOTHING', key, name, description);
      }
    }
    for (const [roleKey, perms] of Object.entries(ROLE_DEFAULTS)) {
      const role = await get('SELECT id FROM roles WHERE key = ?', roleKey);
      if (!role) continue;
      for (const perm of perms.filter((p) => added.includes(p))) {
        await run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING', role.id, perm);
      }
    }
  });
}

// The owner role implicitly holds every permission, including ones added later.
async function forRole(roleKey) {
  if (roleKey === 'owner') return new Set(KEYS);
  const rows = await all(`SELECT rp.permission_key AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ?`, roleKey);
  return new Set(rows.map((r) => r.key).filter((k) => KEYS.has(k)));
}

async function listRoles() {
  const roles = await all(`SELECT r.*, (SELECT COUNT(*) FROM staff s WHERE s.role = r.key) AS member_count
    FROM roles r ORDER BY r.key = 'owner' DESC, r.is_system DESC, r.name`);
  const grants = await all('SELECT r.key, rp.permission_key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id');
  for (const role of roles) {
    role.permissions = role.key === 'owner' ? [...KEYS] : grants.filter((g) => g.key === role.key).map((g) => g.permission_key);
  }
  return roles;
}

// Grouped for the role editor: [{ module, items: [{ key, label, sensitive }] }].
function catalog() {
  const groups = [];
  for (const [key, module, label, sensitive] of PERMISSIONS) {
    let g = groups.find((x) => x.module === module);
    if (!g) groups.push(g = { module, items: [] });
    g.items.push({ key, label, sensitive: Boolean(sensitive) });
  }
  return groups;
}

async function setRolePermissions(roleId, keys) {
  const valid = [...new Set(keys)].filter((k) => KEYS.has(k));
  await tx(async () => {
    await run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
    for (const k of valid) await run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)', roleId, k);
  });
  return valid;
}

async function createRole({ key, name, description }) {
  return insert('INSERT INTO roles (key, name, description, is_system) VALUES (?, ?, ?, 0)', key, name, description || '');
}

module.exports = { PERMISSIONS, KEYS, ROLE_DEFAULTS, sync, forRole, listRoles, catalog, setRolePermissions, createRole };
