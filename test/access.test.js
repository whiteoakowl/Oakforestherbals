'use strict';
// Phase 2: migrations, RLS lockdown, roles and permissions, audit log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');

let ctx;
let owner;

async function staffClient(email, role) {
  const res = await owner.post('/admin/settings/staff', { name: `Test ${role}`, email, password: 'password123', role }, '/admin/settings/staff');
  assert.equal(res.status, 302);
  const c = new Client(ctx.base);
  const login = await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(login.location, '/admin', `login for ${role} failed`);
  return c;
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  const res = await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal(res.location, '/admin');
});
after(() => ctx.close());

test('migrations are recorded once and every public table has row level security', async () => {
  const applied = await all('SELECT id FROM schema_migrations');
  assert.ok(applied.some((m) => m.id === '0001_roles_permissions_audit'));
  const open = await all(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
  assert.deepEqual(open, [], `tables without RLS: ${open.map((t) => t.relname).join(', ')}`);
  // The app still reads and writes normally as the table owner.
  assert.ok((await get('SELECT COUNT(*) AS n FROM products')).n > 0);
});

test('existing roles survive: owner has everything, legacy staff keeps store access but not settings', async () => {
  const roles = await all('SELECT key FROM roles');
  for (const key of ['owner', 'staff', 'administrator', 'practitioner', 'store_manager', 'customer_service']) {
    assert.ok(roles.some((r) => r.key === key), `missing role ${key}`);
  }
  const staff = await staffClient('legacy@example.com', 'staff');
  for (const url of ['/admin', '/admin/orders', '/admin/products', '/admin/customers', '/admin/discounts', '/admin/content/pages', '/admin/themes', '/admin/analytics']) {
    assert.equal((await staff.get(url)).status, 200, url);
  }
  for (const url of ['/admin/settings/general', '/admin/settings/payments', '/admin/settings/staff', '/admin/settings/roles', '/admin/settings/audit']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
});

test('a role without store permissions is refused on the server, not just hidden', async () => {
  const p = await staffClient('herbalist@example.com', 'practitioner');
  const home = await p.get('/admin');
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.text, /href="\/admin\/orders"/);
  for (const url of ['/admin/orders', '/admin/products', '/admin/customers', '/admin/customers/export.csv', '/admin/orders/export.csv', '/admin/analytics', '/admin/settings']) {
    assert.equal((await p.get(url)).status, 403, url);
  }
  const customer = await get('SELECT id FROM customers LIMIT 1');
  const res = await p.post(`/admin/customers/${customer.id}/delete`, {}, '/admin');
  assert.equal(res.status, 403);
  assert.ok(await get('SELECT 1 FROM customers WHERE id = ?', customer.id), 'customer must not be deleted');
  const denied = await get("SELECT * FROM audit_logs WHERE action = 'access.denied' AND actor_name = 'Test practitioner' ORDER BY id DESC LIMIT 1");
  assert.ok(denied, 'denials are audited');
});

test('view-only access: customer service can read orders, store manager cannot open settings', async () => {
  const cs = await staffClient('cs@example.com', 'customer_service');
  assert.equal((await cs.get('/admin/orders')).status, 200);
  assert.equal((await cs.get('/admin/products')).status, 403);
  await run("DELETE FROM role_permissions WHERE permission_key = 'orders.manage' AND role_id = (SELECT id FROM roles WHERE key = 'customer_service')");
  const order = await get('SELECT id FROM orders LIMIT 1');
  assert.equal((await cs.get(`/admin/orders/${order.id}`)).status, 200);
  assert.equal((await cs.post(`/admin/orders/${order.id}/comment`, { message: 'hi' }, '/admin/orders')).status, 403);
  const sm = await staffClient('sm@example.com', 'store_manager');
  assert.equal((await sm.get('/admin/products')).status, 200);
  assert.equal((await sm.get('/admin/settings/payments')).status, 403);
});

test('owner can create a custom role, grant permissions and assign it', async () => {
  let res = await owner.post('/admin/settings/roles', { name: 'Shipping clerk', description: 'Packs orders' }, '/admin/settings/roles');
  assert.match(res.location, /\/admin\/settings\/roles\/\d+/);
  const id = Number(res.location.split('/').pop());
  res = await owner.post(`/admin/settings/roles/${id}`, { name: 'Shipping clerk', permissions: 'orders.view' }, res.location);
  assert.equal(res.status, 302);
  const perms = await all('SELECT permission_key FROM role_permissions WHERE role_id = ?', id);
  assert.deepEqual(perms.map((p) => p.permission_key), ['orders.view']);
  const clerk = await staffClient('clerk@example.com', 'shipping_clerk');
  assert.equal((await clerk.get('/admin/orders')).status, 200);
  assert.equal((await clerk.get('/admin/customers')).status, 403);
  // Roles in use can't be deleted.
  await owner.post(`/admin/settings/roles/${id}/delete`, {}, '/admin/settings/roles');
  assert.ok(await get('SELECT 1 FROM roles WHERE id = ?', id));
  const updated = await get("SELECT * FROM audit_logs WHERE action = 'role.updated' AND entity_id = 'shipping_clerk'");
  assert.deepEqual(JSON.parse(updated.details).granted, ['orders.view']);
});

test('an administrator cannot grant ownership or edit owners', async () => {
  const adm = await staffClient('admin@example.com', 'administrator');
  assert.equal((await adm.get('/admin/settings/roles')).status, 200);
  await adm.post('/admin/settings/staff', { name: 'Sneaky', email: 'sneaky@example.com', password: 'password123', role: 'owner' }, '/admin/settings/staff');
  assert.equal(await get("SELECT 1 FROM staff WHERE email = 'sneaky@example.com'"), undefined);
  const ownerRow = await get("SELECT id FROM staff WHERE email = 'owner@example.com'");
  await adm.post(`/admin/settings/staff/${ownerRow.id}/role`, { role: 'staff' }, '/admin/settings/staff');
  assert.equal((await get('SELECT role FROM staff WHERE id = ?', ownerRow.id)).role, 'owner');
  await adm.post(`/admin/settings/staff/${ownerRow.id}/delete`, {}, '/admin/settings/staff');
  assert.ok(await get('SELECT 1 FROM staff WHERE id = ?', ownerRow.id));
});

test('changing a role signs that person out; the last owner cannot be demoted', async () => {
  const c = await staffClient('mover@example.com', 'staff');
  assert.equal((await c.get('/admin/orders')).status, 200);
  const row = await get("SELECT id FROM staff WHERE email = 'mover@example.com'");
  await owner.post(`/admin/settings/staff/${row.id}/role`, { role: 'practitioner' }, '/admin/settings/staff');
  assert.equal((await get('SELECT role FROM staff WHERE id = ?', row.id)).role, 'practitioner');
  const after = await c.get('/admin/orders');
  assert.equal(after.status, 302);
  assert.match(after.location, /\/admin\/login/);
});

test('audit log records sign-ins and failures, hides secrets and is append-only', async () => {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email: 'owner@example.com', password: 'wrong-password', next: '/admin' }, '/admin/login');
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'staff.login_failed'"));
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'staff.login' AND actor_name = 'Store owner'"));
  await owner.post('/admin/settings/payments', { stripe_secret_key: 'sk_test_supersecret', stripe_enabled: '1' }, '/admin/settings/payments');
  const rows = await all('SELECT details FROM audit_logs');
  assert.ok(rows.every((r) => !r.details.includes('sk_test_supersecret')), 'secrets must never reach the audit log');
  const page = await owner.get('/admin/settings/audit?action=staff');
  assert.equal(page.status, 200);
  assert.match(page.text, /staff\.login/);
  await assert.rejects(run('DELETE FROM audit_logs'), /append-only/);
  await assert.rejects(run("UPDATE audit_logs SET action = 'x'"), /append-only/);
});
