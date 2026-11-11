'use strict';
// Permission matrix: one staff member per system role, every admin area, and the expected answer
// worked out from the role's permissions — so a route that forgets its guard, or a role default
// that grants too much, fails here. Also checks that the sidebar never links to a page the role
// can't open, and that no role but the clinical ones can reach patient records.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { ROLE_DEFAULTS } = require('../src/permissions');

let ctx;
const clients = {};

// [url, who may open it]
const any = (...keys) => (perms) => keys.some((k) => perms.has(k));
const AREAS = [
  ['/admin', () => true],
  ['/admin/communications/notifications', () => true],
  ['/admin/profile', () => true],
  ['/admin/orders', any('orders.view', 'orders.manage')],
  ['/admin/products', any('products.manage')],
  ['/admin/collections', any('products.manage')],
  ['/admin/customers', any('customers.view', 'customers.manage')],
  ['/admin/reviews', any('products.manage')],
  ['/admin/gift-cards', any('orders.manage')],
  ['/admin/settings/store-features', any('settings.manage')],
  ['/admin/settings/security', any('settings.manage')],
  ['/admin/discounts', any('discounts.manage')],
  ['/admin/costing', any('costing.manage')],
  ['/admin/analytics/profitability', any('costing.manage')],
  ['/admin/pos', any('pos.use')],
  ['/admin/content/pages', any('content.manage')],
  ['/admin/analytics', any('analytics.view')],
  ['/admin/herbs', any('herbs.view', 'herbs.manage')],
  ['/admin/inventory', any('inventory.manage')],
  ['/admin/formulas', any('formulas.view', 'formulas.manage')],
  ['/admin/production', any('production.manage')],
  ['/admin/clinic/patients', any('clinic.patients.view_all', 'clinic.patients.view_assigned')],
  ['/admin/clinic/forms', any('clinic.records.manage')],
  ['/admin/education', any('education.manage')],
  ['/admin/schedule', any('scheduling.manage', 'scheduling.own')],
  ['/admin/invoices', any('invoices.manage')],
  ['/admin/finance', any('finance.view')],
  ['/admin/finance/expenses', any('finance.view', 'expenses.manage')],
  ['/admin/communications', any('settings.manage')],
  ['/admin/assistant', any('assistant.use')],
  ['/admin/settings/staff', any('staff.manage')],
  ['/admin/settings/roles', any('staff.manage')],
  ['/admin/settings/audit', any('audit.view')],
];
const ROLES = Object.keys(ROLE_DEFAULTS);

before(async () => {
  ctx = await start();
  const owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  clients.owner = owner;
  for (const role of ROLES) {
    const email = `${role.replace(/_/g, '-')}@example.com`;
    const res = await owner.post('/admin/settings/staff', { name: `Test ${role}`, email, password: 'password123', role }, '/admin/settings/staff');
    assert.ok(res.status < 400, `created ${role}`);
    const c = new Client(ctx.base);
    const login = await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
    assert.equal(login.location, '/admin', `${role} can sign in`);
    clients[role] = c;
  }
});
after(() => ctx.close());

for (const role of ROLES) {
  test(`role "${role}" opens exactly the areas its permissions allow`, async () => {
    const perms = new Set(ROLE_DEFAULTS[role]);
    const wrong = [];
    for (const [url, allowed] of AREAS) {
      const { status } = await clients[role].get(url);
      const expected = allowed(perms) ? 200 : 403;
      if (status !== expected) wrong.push(`${url}: got ${status}, expected ${expected}`);
    }
    assert.deepEqual(wrong, []);
  });

  test(`role "${role}": every sidebar link opens`, async () => {
    const page = await clients[role].get('/admin');
    const nav = page.text.split('<main')[0];
    const links = [...new Set([...nav.matchAll(/href="(\/admin[^"#?]*)"/g)].map((m) => m[1]))].filter((u) => !/logout|login/.test(u));
    assert.ok(links.length > 0);
    const broken = [];
    for (const url of links) {
      const { status } = await clients[role].get(url);
      if (status !== 200) broken.push(`${url}: ${status}`);
    }
    assert.deepEqual(broken, []);
  });
}

test('the owner opens every area', async () => {
  for (const [url] of AREAS) assert.equal((await clients.owner.get(url)).status, 200, url);
});

test('only clinical roles hold clinical permissions by default', () => {
  const clinical = ROLES.filter((r) => ROLE_DEFAULTS[r].some((p) => p.startsWith('clinic.')));
  assert.deepEqual(clinical.sort(), ['clinic_manager', 'practitioner']);
  for (const r of ROLES) assert.ok(!ROLE_DEFAULTS[r].includes('assistant.clinic'), `${r} must not send patient data to the assistant by default`);
});

test('changes are refused without the manage permission, even when viewing is allowed', async () => {
  // Customer service can view and manage orders but not products; a practitioner can view formulas
  // they own but cannot approve them; nobody without staff.manage can create staff.
  const res = await clients.customer_service.post('/admin/products/new', { title: 'Sneaky product' }, '/admin');
  assert.equal(res.status, 403);
  const staffRes = await clients.store_manager.post('/admin/settings/staff', { name: 'X', email: 'x@example.com', password: 'password123', role: 'administrator' }, '/admin');
  assert.equal(staffRes.status, 403);
  const exp = await clients.customer_service.post('/admin/finance/expenses', { description: 'x', amount: '1' }, '/admin');
  assert.equal(exp.status, 403);
});
