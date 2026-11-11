'use strict';
// The admin shell: search everything (permission-scoped), the "+ New" menu and the home page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, insert, run } = require('../src/db');

let ctx;
let owner;
let ann;
let cass;

async function login(email) {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  return c;
}

before(async () => {
  ctx = await start();
  owner = await login('owner@example.com');
  await owner.post('/admin/settings/staff', { name: 'Ann Herbalist', email: 'ann@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  await owner.post('/admin/settings/staff', { name: 'Cass Service', email: 'cass@example.com', password: 'password123', role: 'customer_service' }, '/admin/settings/staff');
  ann = await login('ann@example.com');
  cass = await login('cass@example.com');
  // Two clinic clients; Ann is assigned to only one.
  for (const [first, email] of [['Willow', 'willow@example.com'], ['Rowan', 'rowan@example.com']]) {
    await owner.post('/admin/clinic/patients/new', { email, first_name: first, last_name: 'Grey', consent: '1' }, '/admin/clinic/patients/new');
  }
  const willow = await get("SELECT p.id FROM patients p JOIN customers c ON c.id = p.customer_id WHERE c.email = 'willow@example.com'");
  await run('INSERT INTO practitioner_assignments (patient_id, staff_id) VALUES (?, (SELECT id FROM staff WHERE email = ?))', willow.id, 'ann@example.com');
});
after(() => ctx.close());

test('search covers every area for the owner', async () => {
  const page = await owner.get('/admin/search?q=grey');
  assert.match(page.text, /Clients/);
  assert.match(page.text, /Willow Grey/);
  assert.match(page.text, /Rowan Grey/);
  const products = await owner.get('/admin/search?q=lemon');
  assert.match(products.text, /Products/);
  assert.match(products.text, /Lemon Balm/);
  const order = await get('SELECT id, number FROM orders ORDER BY id LIMIT 1');
  const go = await owner.get(`/admin/search?q=${order.number}&go=1`);
  assert.equal(go.location, `/admin/orders/${order.id}`, 'an exact order number opens it');
});

test('search never shows what the person can’t open', async () => {
  let page = await ann.get('/admin/search?q=grey');
  assert.match(page.text, /Willow Grey/);
  assert.doesNotMatch(page.text, /Rowan Grey/, 'not assigned');
  assert.doesNotMatch(page.text, /Customers/, 'practitioners have no customer list');
  page = await cass.get('/admin/search?q=grey');
  assert.doesNotMatch(page.text, /Clients/, 'no clinic access');
  assert.match(page.text, /Customers/);
  page = await cass.get('/admin/search?q=lemon');
  assert.doesNotMatch(page.text, /Products<\/h2>|>Products /, 'no product access');
});

test('the "+ New" menu offers only what the person can create, and the home page greets them', async () => {
  const o = await owner.get('/admin');
  assert.match(o.text, /href="\/admin\/products\/new">Product</);
  assert.match(o.text, /Good (morning|afternoon|evening), /);
  const a = await ann.get('/admin');
  assert.match(a.text, /href="\/admin\/clinic\/patients\/new">Client record</);
  assert.doesNotMatch(a.text, /href="\/admin\/products\/new"/);
  assert.match(a.text, /Search clients, products, orders, herbs/);
});
