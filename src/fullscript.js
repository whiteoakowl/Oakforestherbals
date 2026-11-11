'use strict';
// Fullscript dispensary, connected by links: the practice keeps its Fullscript dispensary address and a
// library of Fullscript product links; care plans recommend those products (or link a whole Fullscript
// treatment plan), and clients order with one click. Only fullscript.com addresses are accepted, so a
// client is never sent anywhere else. No Fullscript API account is needed.
const { get, all } = require('./db');
const settings = require('./settings');

function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== 'fullscript.com' && !u.hostname.endsWith('.fullscript.com')) return null;
  u.hash = '';
  return u.toString();
}

const config = () => settings.load('fullscript');
const enabled = () => Boolean(config().enabled && cleanUrl(config().dispensary_url));

const library = (includeInactive = false) => all(`SELECT fp.*, h.common_name AS herb_name FROM fullscript_products fp LEFT JOIN herbs h ON h.id = fp.herb_id
  ${includeInactive ? '' : 'WHERE fp.active = 1'} ORDER BY lower(fp.name)`);

// Every Fullscript recommendation in a client's shared care plans.
async function forPatient(patientId) {
  const vault = require('./vault');
  const rows = await all(`SELECT i.id, i.plan_id, i.content_enc, fp.name, fp.brand, fp.url, fp.default_dose FROM care_plan_items i
    JOIN care_plans p ON p.id = i.plan_id JOIN fullscript_products fp ON fp.id = i.fullscript_product_id
    WHERE p.patient_id = ? AND p.shared_with_patient = 1 AND p.status IN ('active', 'completed') ORDER BY p.status = 'active' DESC, i.position`, patientId);
  const plans = (await all("SELECT id, content_enc FROM care_plans WHERE patient_id = ? AND shared_with_patient = 1 AND status IN ('active', 'completed')", patientId))
    .map((p) => ({ id: p.id, content: vault.open(p.content_enc) || {} })).filter((p) => cleanUrl(p.content.fullscript_url));
  return { items: rows.map((r) => ({ ...r, content: vault.open(r.content_enc) || {} })), plans };
}

module.exports = { cleanUrl, config, enabled, library, forPatient, get };
