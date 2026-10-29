'use strict';
// Transactional email. Every message is recorded in email_outbox (visible in admin);
// it is delivered over SMTP when SMTP is configured in Settings > Notifications.
const path = require('node:path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const { run } = require('./db');
const settings = require('./settings');
const { formatMoney, formatDate } = require('./utils');
const { themeColors } = require('./colors');

const VIEWS = path.join(__dirname, '..', 'views', 'emails');

function transport(n) {
  if (!n.smtp_host) return null;
  return nodemailer.createTransport({
    host: n.smtp_host,
    port: Number(n.smtp_port) || 587,
    secure: !!n.smtp_secure,
    auth: n.smtp_user ? { user: n.smtp_user, pass: n.smtp_pass } : undefined,
  });
}

async function send(to, subject, template, data = {}) {
  if (!to) return;
  const n = settings.load('notifications');
  const store = settings.load('store');
  const theme = settings.load('theme');
  const baseUrl = process.env.BASE_URL || '';
  const html = await ejs.renderFile(path.join(VIEWS, `${template}.ejs`), {
    ...data, store, theme, themeColors: themeColors(theme), baseUrl, subject,
    money: (c) => formatMoney(c, store.currency_symbol), formatDate,
  });
  const { lastInsertRowid } = run('INSERT INTO email_outbox (to_address, subject, html) VALUES (?, ?, ?)', to, subject, html);
  const t = transport(n);
  if (!t) {
    run("UPDATE email_outbox SET status = 'logged' WHERE id = ?", lastInsertRowid);
    return;
  }
  try {
    await t.sendMail({ from: `"${n.sender_name}" <${n.sender_email}>`, to, subject, html });
    run("UPDATE email_outbox SET status = 'sent' WHERE id = ?", lastInsertRowid);
  } catch (err) {
    run("UPDATE email_outbox SET status = 'failed', error = ? WHERE id = ?", String(err.message || err), lastInsertRowid);
  }
}

// Fire-and-forget wrapper so a mail failure never breaks a request.
function notify(enabledKey, to, subject, template, data) {
  if (enabledKey && !settings.load('notifications')[enabledKey]) return;
  send(to, subject, template, data).catch((err) => console.error('[mail]', err));
}

module.exports = { send, notify };
