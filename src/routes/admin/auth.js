'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { get, all, run, insert } = require('../../db');
const settings = require('../../settings');
const { flash, throttle } = require('../../middleware');
const audit = require('../../audit');
const twofactor = require('../../twofactor');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/admin') ? n : '/admin');

async function signIn(req, staffId, done) {
  await run('UPDATE staff SET last_login_at = now() WHERE id = ?', staffId);
  const { cart } = req.session;
  req.session.regenerate(() => {
    Object.assign(req.session, { cart, staffId, pending2fa: null });
    done();
  });
}

// When SETUP_KEY is set (recommended on a public deployment), creating the owner requires it.
function setupKeyOk(sent) {
  const expected = process.env.SETUP_KEY || '';
  if (!expected) return true;
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// First-run wizard: creates the owner account when no staff exist yet.
router.get('/setup', async (req, res) => {
  if (await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'Set up your store', needsKey: Boolean(process.env.SETUP_KEY) });
});

router.post('/setup', async (req, res) => {
  if (await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/login');
  const { name = '', email = '', password = '', store_name = '' } = req.body;
  if (!setupKeyOk(req.body.setup_key)) {
    flash(req, 'error', 'The setup key is incorrect.');
    return res.redirect('/admin/setup');
  }
  if (!email.includes('@') || password.length < 8 || !name.trim()) {
    flash(req, 'error', 'Enter your name, a valid email and a password of at least 8 characters.');
    return res.redirect('/admin/setup');
  }
  const id = await insert("INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')",
    email.trim(), name.trim(), bcrypt.hashSync(password, 10));
  if (store_name.trim()) await settings.save('store', { name: store_name.trim(), email: email.trim() });
  await audit.record(req, 'staff.owner_setup', { entityType: 'staff', entityId: id, actor: { type: 'staff', id, name: name.trim() }, details: { email: email.trim() } });
  await signIn(req, id, () => res.redirect('/admin'));
});

router.get('/login', async (req, res) => {
  if (res.locals.staff) return res.redirect('/admin');
  if (!await get('SELECT 1 FROM staff LIMIT 1')) return res.redirect('/admin/setup');
  res.render('admin/login', { title: 'Log in', next: safeNext(req.query.next) });
});

router.post('/login', throttle('staff'), async (req, res) => {
  const staff = await get('SELECT * FROM staff WHERE email = ?', String(req.body.email || '').trim());
  if (!staff || !bcrypt.compareSync(String(req.body.password || ''), staff.password_hash)) {
    await audit.record(req, 'staff.login_failed', { details: { email: String(req.body.email || '').trim().slice(0, 200) } });
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect(`/admin/login?next=${encodeURIComponent(safeNext(req.body.next))}`);
  }
  if (staff.totp_enabled_at) {
    // Password was right; the code from their authenticator app is still needed.
    req.session.pending2fa = { staffId: staff.id, next: safeNext(req.body.next), at: Date.now(), attempts: 0 };
    return res.redirect('/admin/login/verify');
  }
  await audit.record(req, 'staff.login', { entityType: 'staff', entityId: staff.id, actor: { type: 'staff', id: staff.id, name: staff.name } });
  await signIn(req, staff.id, () => res.redirect(safeNext(req.body.next)));
});

const PENDING_MS = 5 * 60 * 1000;
const pending = (req) => {
  const p = req.session.pending2fa;
  return p && Date.now() - p.at < PENDING_MS && p.attempts < 5 ? p : null;
};

router.get('/login/verify', (req, res) => {
  if (!pending(req)) { req.session.pending2fa = null; return res.redirect('/admin/login'); }
  res.render('admin/login-verify', { title: 'Two-step sign-in' });
});

router.post('/login/verify', throttle('staff2fa'), async (req, res) => {
  const p = pending(req);
  if (!p) {
    req.session.pending2fa = null;
    flash(req, 'error', 'That took too long or had too many tries. Please sign in again.');
    return res.redirect('/admin/login');
  }
  const staff = await get('SELECT id, name, email FROM staff WHERE id = ?', p.staffId);
  const result = staff ? await twofactor.check(staff.id, req.body.code) : { ok: false };
  if (!result.ok) {
    p.attempts += 1;
    await audit.record(req, 'staff.two_factor_failed', { entityType: 'staff', entityId: p.staffId, actor: staff ? { type: 'staff', id: staff.id, name: staff.name } : undefined });
    flash(req, 'error', 'That code didn’t work. Check your authenticator app and try again.');
    return res.redirect('/admin/login/verify');
  }
  await audit.record(req, 'staff.login', { entityType: 'staff', entityId: staff.id, actor: { type: 'staff', id: staff.id, name: staff.name }, details: { two_factor: result.recovery ? 'recovery_code' : 'app' } });
  if (result.recovery) flash(req, 'info', `You used a recovery code. ${await twofactor.remainingCodes(staff.id)} left — make new ones under Your profile if you're running low.`);
  await signIn(req, staff.id, () => res.redirect(p.next));
});

/* ---------- Forgot password (staff) ---------- */

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
// Signs someone out everywhere after their password changes. Matches the id exactly.
const endSessions = (id) => run('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?', `%"staffId":${id},%`, `%"staffId":${id}}%`);
const recoveryKey = () => process.env.ADMIN_RECOVERY_KEY || '';

router.get('/forgot', (req, res) => res.render('admin/forgot', { title: 'Reset your password', recovery: Boolean(recoveryKey()) }));

router.post('/forgot', throttle('staffreset'), async (req, res) => {
  const staff = await get('SELECT id, email, name FROM staff WHERE email = ?', String(req.body.email || '').trim());
  if (staff) {
    const t = crypto.randomBytes(32).toString('base64url');
    await run("INSERT INTO staff_password_resets (token_hash, staff_id, expires_at) VALUES (?, ?, now() + interval '1 hour')", hashToken(t), staff.id);
    const url = `${req.protocol}://${req.get('host')}/admin/reset/${t}`;
    await require('../../mailer').notify(null, staff.email, 'Reset your admin password', 'password-reset', { url });
    await audit.record(req, 'staff.password_reset_requested', { entityType: 'staff', entityId: staff.id, actor: { type: 'staff', id: staff.id, name: staff.name } });
  }
  // Same answer either way, so the form can't be used to find out who has an account.
  flash(req, 'success', 'If that email belongs to a staff account, we’ve sent a link to reset the password. It works for one hour.');
  res.redirect('/admin/login');
});

async function resetRow(token) {
  return get('SELECT r.*, s.email, s.name FROM staff_password_resets r JOIN staff s ON s.id = r.staff_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > now()', hashToken(token));
}

router.get('/reset/:token', async (req, res) => {
  const r = await resetRow(req.params.token);
  if (!r) { flash(req, 'error', 'This reset link is invalid or has expired. Ask for a new one.'); return res.redirect('/admin/forgot'); }
  res.render('admin/reset', { title: 'Choose a new password', action: `/admin/reset/${req.params.token}`, email: r.email, owners: null });
});

router.post('/reset/:token', throttle('staffreset'), async (req, res) => {
  const r = await resetRow(req.params.token);
  if (!r) { flash(req, 'error', 'This reset link is invalid or has expired. Ask for a new one.'); return res.redirect('/admin/forgot'); }
  const password = String(req.body.password || '');
  if (password.length < 8 || password !== String(req.body.confirm || '')) { flash(req, 'error', 'Enter the same new password twice, at least 8 characters.'); return res.redirect(`/admin/reset/${req.params.token}`); }
  const claimed = await run('UPDATE staff_password_resets SET used_at = now() WHERE token_hash = ? AND used_at IS NULL', r.token_hash);
  if (!claimed.changes) return res.redirect('/admin/forgot');
  await run('UPDATE staff SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), r.staff_id);
  await endSessions(r.staff_id);
  await audit.record(req, 'staff.password_reset', { entityType: 'staff', entityId: r.staff_id, actor: { type: 'staff', id: r.staff_id, name: r.name } });
  flash(req, 'success', 'Password changed. Log in with your new password.');
  res.redirect('/admin/login');
});

/* ---------- Owner recovery (no email needed) ----------
 * For when the owner has lost their login entirely. Works only while ADMIN_RECOVERY_KEY is set in the
 * hosting environment, so only someone who controls the site's settings can use it. */

const RECOVERY_MS = 10 * 60 * 1000;
const recoveryOpen = (req) => Boolean(recoveryKey() && req.session.recoveryAt && Date.now() - req.session.recoveryAt < RECOVERY_MS);

router.get('/recover', async (req, res) => {
  if (!recoveryKey()) return res.render('admin/recover', { title: 'Recover the owner account', enabled: false, owners: null });
  const owners = recoveryOpen(req) ? await all("SELECT id, name, email, totp_enabled_at IS NOT NULL AS two_factor FROM staff WHERE role = 'owner' ORDER BY id") : null;
  res.render('admin/recover', { title: 'Recover the owner account', enabled: true, owners });
});

router.post('/recover', throttle('recover'), async (req, res) => {
  if (!recoveryKey()) return res.redirect('/admin/recover');
  const sent = Buffer.from(String(req.body.key || ''));
  const expected = Buffer.from(recoveryKey());
  if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    await audit.record(req, 'staff.recovery_failed', {});
    flash(req, 'error', 'That recovery key is incorrect.');
    return res.redirect('/admin/recover');
  }
  req.session.recoveryAt = Date.now();
  res.redirect('/admin/recover');
});

router.post('/recover/reset', throttle('recover'), async (req, res) => {
  if (!recoveryOpen(req)) { flash(req, 'error', 'Enter the recovery key again.'); return res.redirect('/admin/recover'); }
  const owner = await get("SELECT id, name, email FROM staff WHERE id = ? AND role = 'owner'", Number(req.body.staff_id) || 0);
  const password = String(req.body.password || '');
  if (!owner) { flash(req, 'error', 'Choose the owner account.'); return res.redirect('/admin/recover'); }
  if (password.length < 8 || password !== String(req.body.confirm || '')) { flash(req, 'error', 'Enter the same new password twice, at least 8 characters.'); return res.redirect('/admin/recover'); }
  await run('UPDATE staff SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), owner.id);
  if (req.body.disable_two_factor === '1') await twofactor.disable(owner.id);
  await endSessions(owner.id);
  req.session.recoveryAt = null;
  await audit.record(req, 'staff.owner_recovered', { entityType: 'staff', entityId: owner.id, actor: { type: 'system', id: null, name: 'Recovery key' }, details: { two_factor_cleared: req.body.disable_two_factor === '1' } });
  flash(req, 'success', `Password set for ${owner.email}. Log in now, then remove ADMIN_RECOVERY_KEY from Netlify.`);
  res.redirect('/admin/login');
});

router.post('/logout', async (req, res) => {
  if (res.locals.staff) await audit.record(req, 'staff.logout', { entityType: 'staff', entityId: res.locals.staff.id });
  req.session.regenerate(() => res.redirect('/admin/login'));
});

module.exports = router;
