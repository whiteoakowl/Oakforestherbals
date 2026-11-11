'use strict';
// Runs the clinic and shop automations every hour (appointment reminders, invoice reminders and
// the daily digest). Scheduled in netlify.toml; each step is safe to run more than once.
const { runAll } = require('../../src/automation');
const { ready } = require('../../src/db');
const settings = require('../../src/settings');
const { sync } = require('../../src/permissions');

exports.handler = async () => {
  await ready;
  await settings.refresh();
  await sync();
  const summary = await runAll('schedule');
  return { statusCode: 200, body: JSON.stringify(summary) };
};
