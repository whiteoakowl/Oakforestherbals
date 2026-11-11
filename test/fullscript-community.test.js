'use strict';
// Fullscript dispensary links and group program community spaces.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, run } = require('../src/db');
const bcrypt = require('bcryptjs');

let ctx;
let ann;
let ben;
const ids = {};
const clients = {};

async function staff(email) {
  const c = new Client(ctx.base);
  await c.post('/admin/login', { email, password: 'password123', next: '/admin' }, '/admin/login');
  return c;
}
async function portal(email) {
  await run('UPDATE customers SET password_hash = ? WHERE email = ?', bcrypt.hashSync('password123', 4), email);
  const c = new Client(ctx.base);
  await c.post('/account/login', { email, password: 'password123' }, '/account/login');
  return c;
}

before(async () => {
  ctx = await start();
  const owner = await staff('owner@example.com');
  for (const [name, email] of [['Ann Herbalist', 'ann@example.com'], ['Ben Herbalist', 'ben@example.com']]) await owner.post('/admin/settings/staff', { name, email, password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  ann = await staff('ann@example.com');
  ben = await staff('ben@example.com');
  for (const [first, last, email] of [['Nia', 'Brook', 'nia@example.com'], ['Leo', 'Stone', 'leo@example.com'], ['Kai', 'Reed', 'kai@example.com']]) {
    const r = await ann.post('/admin/clinic/patients/new', { email, first_name: first, last_name: last, consent: '1' }, '/admin/clinic/patients/new');
    ids[first] = Number(r.location.split('/').pop());
  }
});
after(() => ctx.close());

/* ---------- Fullscript ---------- */

test('only fullscript.com links are accepted for the dispensary and supplements', async () => {
  let res = await ann.post('/admin/fullscript/products', { name: 'Magnesium glycinate', brand: 'Example Labs', url: 'https://evil.example.com/fullscript.com', default_dose: '1 capsule at night' }, '/admin/fullscript');
  assert.equal(await get('SELECT 1 FROM fullscript_products'), undefined);
  await ann.post('/admin/fullscript/products', { name: 'Magnesium glycinate', brand: 'Example Labs', url: 'http://us.fullscript.com/catalog/products/mag', default_dose: '1 capsule at night' }, '/admin/fullscript');
  assert.equal(await get('SELECT 1 FROM fullscript_products'), undefined, 'https only');
  await ann.post('/admin/fullscript/products', { name: 'Magnesium glycinate', brand: 'Example Labs', url: 'https://us.fullscript.com/catalog/products/mag#x', default_dose: '1 capsule at night' }, '/admin/fullscript');
  ids.fsProduct = (await get('SELECT id, url FROM fullscript_products')).id;
  assert.equal((await get('SELECT url FROM fullscript_products')).url, 'https://us.fullscript.com/catalog/products/mag');
  res = await ann.post('/admin/fullscript/settings', { dispensary_url: 'https://example.com/welcome', enabled: '1' }, '/admin/fullscript');
  assert.match((await ann.get(res.location)).text, /Paste your dispensary address/);
  await ann.post('/admin/fullscript/settings', { dispensary_url: 'https://us.fullscript.com/welcome/oak-forest', enabled: '1', note: 'Clients get 10% off' }, '/admin/fullscript');
  assert.match((await ann.get('/admin/fullscript')).text, /Connected/);
});

test('a care plan recommends a Fullscript supplement and the client orders it through a recorded link', async () => {
  const base = `/admin/clinic/patients/${ids.Nia}`;
  await ann.post(`${base}/plans`, { title: 'Sleep support' }, `${base}?tab=plans`);
  const plan = await get('SELECT id FROM care_plans WHERE patient_id = ?', ids.Nia);
  await ann.post(`${base}/plans/${plan.id}/items`, { kind: 'supplement', title: '', fullscript_product_id: String(ids.fsProduct), timing: 'before bed' }, `${base}?tab=plans`);
  await ann.post(`${base}/plans/${plan.id}`, { title: 'Sleep support', status: 'active', shared: '1', fullscript_url: 'https://us.fullscript.com/plans/abc123' }, `${base}?tab=plans`);
  const item = await get('SELECT * FROM care_plan_items WHERE plan_id = ?', plan.id);
  assert.equal(item.fullscript_product_id, ids.fsProduct);
  assert.match((await ann.get(`${base}?tab=plans`)).text, /Fullscript: <a href="https:\/\/us\.fullscript\.com\/catalog\/products\/mag"/);

  clients.nia = await portal('nia@example.com');
  let page = await clients.nia.get(`/account/clinic/plans/${plan.id}`);
  assert.match(page.text, /Order Magnesium glycinate on Fullscript/);
  assert.match(page.text, /Order my supplements on Fullscript/);
  page = await clients.nia.get('/account/clinic/supplements');
  assert.match(page.text, /Magnesium glycinate/);
  assert.match(page.text, /1 capsule at night · before bed/, 'usual dose filled in');
  assert.match(page.text, /Clients get 10% off/);
  let res = await clients.nia.get(`/account/clinic/fullscript?item=${item.id}`);
  assert.equal(res.location, 'https://us.fullscript.com/catalog/products/mag');
  res = await clients.nia.get(`/account/clinic/fullscript?plan=${plan.id}`);
  assert.equal(res.location, 'https://us.fullscript.com/plans/abc123');
  assert.equal((await clients.nia.get('/account/clinic/fullscript')).location, 'https://us.fullscript.com/welcome/oak-forest');
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'portal.fullscript_opened'"));
  // Another client can't use Nia's item.
  clients.leo = await portal('leo@example.com');
  assert.equal((await clients.leo.get(`/account/clinic/fullscript?item=${item.id}`)).status, 404);
});

/* ---------- Community spaces ---------- */

test('a practitioner opens a community and invites only clients they can see', async () => {
  const res = await ann.post('/admin/communities', { name: 'Spring sleep group', description: 'Six weeks together' }, '/admin/communities');
  ids.community = Number(res.location.split('/').pop());
  const page = await ann.get(res.location);
  assert.match(page.text, /Invite clients/);
  await ann.post(`/admin/communities/${ids.community}/invite`, { patient_id: [String(ids.Nia), String(ids.Leo)].join(',') }, res.location);
  assert.equal((await get('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', ids.community)).n, 2);
  const mail = await get("SELECT * FROM email_outbox WHERE template = 'community_invite' AND to_address = 'nia@example.com'");
  assert.match(mail.subject, /Spring sleep group/);
  // Ben isn't assigned to Kai's record... nor anyone's: his invite does nothing.
  await ben.post(`/admin/communities/${ids.community}/invite`, { patient_id: String(ids.Kai) }, '/admin/communities');
  assert.equal((await get('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', ids.community)).n, 2);
});

test('clients join after accepting the guidelines, post and reply under their chosen name', async () => {
  const base = `/account/clinic/community/${ids.community}`;
  let page = await clients.nia.get(base);
  assert.match(page.text, /Before you join/);
  assert.match(page.text, /value="Nia B\."/);
  await clients.nia.post(`${base}/join`, { display_name: 'Nia' }, base);
  assert.equal((await get('SELECT accepted_at FROM community_members WHERE patient_id = ?', ids.Nia)).accepted_at, null, 'must accept the guidelines');
  await clients.nia.post(`${base}/join`, { display_name: 'Nia', accept: '1' }, base);
  await clients.nia.post(`${base}/posts`, { body: 'Day 3: fell asleep before 11 for the first time!' }, base);
  const post = await get('SELECT * FROM community_posts WHERE community_id = ?', ids.community);
  assert.equal(post.author_name, 'Nia');
  assert.doesNotMatch(post.body_enc, /fell asleep/, 'stored encrypted');
  assert.ok(await get("SELECT 1 FROM notifications WHERE kind = 'community'"));
  await clients.leo.post(`${base}/join`, { display_name: 'Leo S.', accept: '1' }, base);
  await clients.leo.post(`${base}/posts`, { body: 'Well done Nia!', parent_id: String(post.id) }, base);
  page = await clients.leo.get(base);
  assert.match(page.text, /Day 3: fell asleep/);
  assert.match(page.text, /Well done Nia!/);
  assert.doesNotMatch(page.text, /Brook/, 'surnames never shown unless chosen');
  // Kai, not invited, can't see the group.
  clients.kai = await portal('kai@example.com');
  assert.equal((await clients.kai.get(base)).status, 404);
  assert.equal((await clients.kai.post(`${base}/posts`, { body: 'hi' }, '/account/clinic')).status, 404);
});

test('facilitators pin, hide reported posts and mute members; archived groups disappear', async () => {
  const base = `/account/clinic/community/${ids.community}`;
  const reply = await get('SELECT * FROM community_posts WHERE parent_id IS NOT NULL');
  await clients.nia.post(`${base}/posts/${reply.parent_id}/report`, {}, base);
  let admin = await ann.get(`/admin/communities/${ids.community}`);
  assert.match(admin.text, /Reported by a member/);
  await ann.post(`/admin/communities/${ids.community}/posts/${reply.parent_id}`, { action: 'pin' }, `/admin/communities/${ids.community}`);
  await ann.post(`/admin/communities/${ids.community}/posts/${reply.id}`, { action: 'hide', reason: 'Off topic' }, `/admin/communities/${ids.community}`);
  assert.doesNotMatch((await clients.nia.get(base)).text, /Well done Nia!/);
  assert.match((await clients.nia.get(base)).text, /📌/);
  const leoMember = await get('SELECT id FROM community_members WHERE patient_id = ?', ids.Leo);
  await ann.post(`/admin/communities/${ids.community}/members/${leoMember.id}`, { action: 'mute' }, `/admin/communities/${ids.community}`);
  await clients.leo.post(`${base}/posts`, { body: 'Can I still post?' }, base);
  assert.equal(await get("SELECT 1 FROM community_posts WHERE author_name = 'Leo S.' AND parent_id IS NULL"), undefined);
  await ann.post(`/admin/communities/${ids.community}/posts`, { body: 'Week 2 starts Monday', pin: '1' }, `/admin/communities/${ids.community}`);
  assert.match((await clients.nia.get(base)).text, /Ann Herbalist \(facilitator\)/);
  await ann.post(`/admin/communities/${ids.community}`, { name: 'Spring sleep group', status: 'archived' }, `/admin/communities/${ids.community}`);
  assert.equal((await clients.nia.get(base)).status, 404);
  admin = await ann.get('/admin/communities');
  assert.match(admin.text, /archived/);
});
