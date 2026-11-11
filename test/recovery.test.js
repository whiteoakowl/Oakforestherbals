'use strict';
// Staff "forgot password" links and owner recovery with ADMIN_RECOVERY_KEY.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, run } = require('../src/db');

let ctx;
before(async () => { ctx = await start(); });
after(() => { delete process.env.ADMIN_RECOVERY_KEY; return ctx.close(); });

test('forgot password emails a one-hour, single-use link and never reveals who has an account', async () => {
  const c = new Client(ctx.base);
  assert.match((await c.get('/admin/login')).text, /Forgot your password\?/);
  let res = await c.post('/admin/forgot', { email: 'nobody@example.com' }, '/admin/forgot');
  assert.equal(res.location, '/admin/login');
  assert.equal(await get("SELECT 1 FROM email_outbox WHERE to_address = 'nobody@example.com'"), undefined);
  res = await c.post('/admin/forgot', { email: 'owner@example.com' }, '/admin/forgot');
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'owner@example.com' AND subject = 'Reset your admin password'");
  const link = mail.html.match(/\/admin\/reset\/([\w-]+)/)[1];
  assert.equal(await get('SELECT 1 FROM staff_password_resets WHERE token_hash = ?', link), undefined, 'only a hash is stored');
  // An existing session ends when the password changes.
  const old = new Client(ctx.base);
  await old.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal((await old.get('/admin')).status, 200);
  res = await c.post(`/admin/reset/${link}`, { password: 'new-pass-123', confirm: 'nope' }, `/admin/reset/${link}`);
  assert.equal(res.location, `/admin/reset/${link}`);
  res = await c.post(`/admin/reset/${link}`, { password: 'new-pass-123', confirm: 'new-pass-123' }, `/admin/reset/${link}`);
  assert.equal(res.location, '/admin/login');
  assert.equal((await old.get('/admin')).status, 302, 'signed out everywhere');
  const login = await new Client(ctx.base).post('/admin/login', { email: 'owner@example.com', password: 'new-pass-123', next: '/admin' }, '/admin/login');
  assert.equal(login.location, '/admin');
  // Used once only.
  assert.equal((await c.get(`/admin/reset/${link}`)).location, '/admin/forgot');
});

test('owner recovery works only with the recovery key, shows the owner email and can clear two-step sign-in', async () => {
  const c = new Client(ctx.base);
  assert.match((await c.get('/admin/recover')).text, /Add <code>ADMIN_RECOVERY_KEY<\/code>/);
  process.env.ADMIN_RECOVERY_KEY = 'a-very-long-recovery-key-123';
  await run("UPDATE staff SET totp_enabled_at = now() WHERE email = 'owner@example.com'");
  await c.post('/admin/recover', { key: 'wrong' }, '/admin/recover');
  assert.doesNotMatch((await c.get('/admin/recover')).text, /name="staff_id"/);
  assert.equal((await c.post('/admin/recover/reset', { staff_id: '1', password: 'x'.repeat(10), confirm: 'x'.repeat(10) }, '/admin/recover')).location, '/admin/recover');
  await c.post('/admin/recover', { key: 'a-very-long-recovery-key-123' }, '/admin/recover');
  const page = await c.get('/admin/recover');
  assert.match(page.text, /owner@example.com/);
  assert.match(page.text, /Also turn off two-step sign-in/);
  const owner = await get("SELECT id FROM staff WHERE email = 'owner@example.com'");
  const res = await c.post('/admin/recover/reset', { staff_id: String(owner.id), password: 'recovered-pw-1', confirm: 'recovered-pw-1', disable_two_factor: '1' }, '/admin/recover');
  assert.equal(res.location, '/admin/login');
  assert.equal((await get('SELECT totp_enabled_at FROM staff WHERE id = ?', owner.id)).totp_enabled_at, null);
  const login = await new Client(ctx.base).post('/admin/login', { email: 'owner@example.com', password: 'recovered-pw-1', next: '/admin' }, '/admin/login');
  assert.equal(login.location, '/admin');
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'staff.owner_recovered'"));
  assert.ok(await get("SELECT 1 FROM audit_logs WHERE action = 'staff.recovery_failed'"));
  // The recovery window closes after use.
  assert.doesNotMatch((await c.get('/admin/recover')).text, /name="staff_id"/);
});
