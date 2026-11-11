'use strict';
// The AI assistant. It answers staff questions with Claude, using read-only tools that run with
// the asking staff member's own permissions — it can never see more than they can, and it has no
// tool that changes anything. It is practitioner-supervised: it does not diagnose, prescribe or
// create recommendations, and it cites only sources stored in the herbal database.
//
// Requires ANTHROPIC_API_KEY. Patient records are sent to Anthropic only when the staff member
// holds `assistant.clinic` (off for every role by default) and can already see that patient.
const { get, all } = require('./db');
const herbs = require('./herbs');
const formulas = require('./formulas');
const inventory = require('./inventory');
const clinic = require('./clinic');
const vault = require('./vault');

const MODEL = 'claude-opus-5-5';
const MAX_TURNS = 6;

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  // Netlify functions time out at 26 seconds at most, so keep each call inside that.
  client = new Anthropic({ timeout: 25000, maxRetries: 1 });
  return client;
}
const configured = () => Boolean(client || process.env.ANTHROPIC_API_KEY);
// Tests replace the client with a fake.
function setClient(c) { client = c; }

const SYSTEM = `You are the assistant inside Oak Forest Herbals' practice software, helping herbalists and staff.
Rules you always follow:
- Answer only from the results of your tools. If the tools return nothing relevant, say so plainly. Never invent herbs, doses, safety information, studies or citations.
- When you mention a use or a safety point, give its evidence level and source exactly as the tool returned them (for example "traditional — Source title"). Keep traditions separate (Western, Ayurveda, TCM): do not merge their concepts.
- Distinguish traditional use, preliminary research and clinical research. Never present traditional use as proven.
- You support a qualified practitioner; you do not replace them. Do not diagnose, do not prescribe, and do not tell anyone to start, stop or change a medication or herb. You may summarise records and point out things the practitioner may want to review, such as safety entries or interactions recorded in the database.
- You cannot change any data. If asked to, explain where in the software the person can do it.
- If a tool says permission is missing, tell the person their role does not include that information.
- Be concise. Use short paragraphs or simple lists.`;

const TOOLS = [
  ['search_herbs', 'herbs.view', 'Search the herbal database by name (common, Latin or synonym), action, condition or constituent. Returns matching herbs with their slug.',
    { query: { type: 'string', description: 'What to search for' } }, ['query']],
  ['herb_profile', 'herbs.view', 'Full profile of one herb: names, actions, uses (with tradition and evidence level), preparations, constituents and safety entries, each with its source.',
    { slug: { type: 'string', description: 'The herb slug from search_herbs' } }, ['slug']],
  ['formula', 'formulas.view', 'Look up a formula the user can see: ingredients with amounts, percentages and costs, cost per batch, and safety entries for its herbs. Optionally scale it to a new batch size.',
    { name: { type: 'string', description: 'Formula name or part of it' }, scale_qty: { type: 'number', description: 'Optional new batch size' }, scale_unit: { type: 'string', description: 'Unit for scale_qty, e.g. g, kg, ml, l, oz' } }, ['name']],
  ['inventory_status', 'inventory.manage', 'Apothecary stock: materials at or below their reorder point, and lots expired or expiring soon. Optional search text.',
    { search: { type: 'string', description: 'Optional material name or lot code' } }, []],
  ['sales_summary', 'analytics.view', 'Store sales for the last N days: order count, revenue, refunds and top products.',
    { days: { type: 'integer', description: 'Number of days back, 1-365' } }, ['days']],
  ['patient_summary', 'assistant.clinic', 'Summary of one patient the user can see: profile, active health items (concerns, medications, allergies...), recent signed notes and active care plans. Search by name or patient number.',
    { patient: { type: 'string', description: 'Patient name, email or number' } }, ['patient']],
];

function toolsFor(staff) {
  return TOOLS.filter(([, perm]) => staff.permissions.has(perm) && (perm !== 'assistant.clinic' || clinic.canSeeAny(staff)))
    .map(([name, , description, properties, required]) => ({ name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } }));
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const money = (cents) => (Number(cents || 0) / 100).toFixed(2);

const handlers = {
  async search_herbs({ query }) {
    const q = herbs.parseQuery({ q: String(query || '').slice(0, 200) });
    const { total, rows } = await herbs.search(q, { limit: 15 });
    return { total, herbs: rows.map((h) => ({ slug: h.slug, common_name: h.common_name, latin_name: h.latin_name, family: h.family, actions: h.actions, summary: h.summary })) };
  },
  async herb_profile({ slug }) {
    const h = await herbs.profile(String(slug || ''));
    if (!h || h.status !== 'published') return { error: 'No published herb with that slug.' };
    const src = (id) => { const s = h.sources.find((x) => x.id === id); return s ? `${s.title}${s.authors ? ` (${s.authors})` : ''}${s.year ? `, ${s.year}` : ''}` : null; };
    return {
      common_name: h.common_name, latin_name: h.latin_name, family: h.family, summary: h.summary,
      other_names: h.names.map((n) => `${n.name}${n.tradition ? ` (${n.tradition})` : ''}`),
      terms: h.links.map((l) => ({ vocabulary: l.vocabulary, term: l.name, tradition: l.tradition || null, source: src(l.source_id) })),
      tradition_profiles: h.profiles.map((p) => ({ tradition: p.tradition, local_name: p.local_name || null, description: p.description || null, source: src(p.source_id) })),
      uses: h.uses.map((u) => ({ condition: u.condition || null, description: u.description || null, tradition: u.tradition, evidence: u.evidence, body_system: u.body_system, source: src(u.source_id) })),
      preparations: h.preparations.map((p) => ({ method: p.method, plant_part: p.plant_part || null, menstruum: p.menstruum || null, ratio: p.ratio || null, notes: p.notes || null, source: src(p.source_id) })),
      constituents: h.constituents.map((c) => ({ name: c.name, class: c.class_name })),
      safety: h.safety.map((s) => ({ kind: s.kind, detail: s.description, evidence: s.evidence, source: src(s.source_id) })),
      missing_information: h.missing,
    };
  },
  async formula({ name, scale_qty: scaleQty, scale_unit: scaleUnit }, staff) {
    const v = formulas.visibleSql(staff.id);
    const f = await get(`SELECT * FROM formulas f WHERE f.name ILIKE ? AND ${v.sql} ORDER BY f.id LIMIT 1`, `%${String(name || '').slice(0, 200)}%`, ...v.params);
    if (!f) return { error: 'No formula you can see matches that name.' };
    const r = await formulas.resolve(f);
    const safety = await formulas.safety(f.id);
    const out = {
      name: f.name, category: f.category, status: f.status, entry_mode: f.entry_mode, batch_yield: `${Number(f.yield_qty)} ${f.yield_unit}`,
      ingredients: r.lines.map((l) => ({ ingredient: l.name, entered: `${l.quantity}${f.entry_mode === 'percent' ? '%' : f.entry_mode === 'parts' ? ' parts' : ` ${l.unit}`}`, amount: `${Math.round(l.amount * 1000) / 1000} ${l.amount_unit}`, percent_of_batch: l.percent, cost: money(l.cost) })),
      batch_cost: { materials: money(r.cost.materials), waste: money(r.cost.waste), labour: money(r.cost.labour), overhead: money(r.cost.overhead), total: money(r.cost.total) }, problems: r.problems,
      safety_notes: f.safety_notes || null,
      safety_entries: safety.entries.map((e) => ({ herb: e.common_name, kind: e.kind, detail: e.description, evidence: e.evidence, source: e.source_title })),
      herbs_without_safety_entries: safety.noSafety.map((h) => h.common_name), ingredients_not_linked_to_herb_database: safety.unlinked.map((m) => m.name),
    };
    if (scaleQty && scaleUnit) {
      const factor = formulas.scaleFactor(f, scaleQty, scaleUnit);
      if (factor === null) out.scaled = { error: `Can't convert ${scaleUnit} to ${f.yield_unit}.` };
      else out.scaled = { to: `${scaleQty} ${scaleUnit}`, factor: Math.round(factor * 10000) / 10000, ingredients: r.lines.map((l) => ({ ingredient: l.name, amount: `${Math.round(l.amount * factor * 1000) / 1000} ${l.amount_unit}`, cost: money(l.cost * factor) })) };
    }
    return out;
  },
  async inventory_status({ search }) {
    const s = await inventory.stockSummary({ q: String(search || '').slice(0, 100) });
    const pick = (r) => ({ material: r.name, on_hand: inventory.fmtQty(r.on_hand, r), reorder_point: r.reorder_point, next_expiry: r.next_expiry, supplier: r.supplier_name });
    return { stock_value: money(s.totalValue), low_stock: s.rows.filter((r) => r.low).map(pick), expired_or_expiring: s.rows.filter((r) => r.expired || r.expiring).map(pick), expiry_warning_days: s.warnDays, matched: search ? s.rows.slice(0, 20).map(pick) : undefined };
  },
  async sales_summary({ days }) {
    const d = Math.min(365, Math.max(1, Number(days) || 30));
    const since = new Date(Date.now() - d * 86400000).toISOString();
    const t = await get("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(refunded_total), 0) AS refunds FROM orders WHERE created_at >= ? AND status != 'cancelled' AND financial_status != 'pending'", since);
    const top = await all(`SELECT i.title, SUM(i.quantity) AS units, SUM(i.quantity * i.price) AS sales FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.created_at >= ? AND o.status != 'cancelled' AND o.financial_status != 'pending' GROUP BY i.title ORDER BY sales DESC LIMIT 8`, since);
    return { days: d, paid_orders: Number(t.n), revenue: money(t.revenue), refunds: money(t.refunds), top_products: top.map((p) => ({ product: p.title, units: Number(p.units), sales: money(p.sales) })) };
  },
  async patient_summary({ patient }, staff) {
    const s = clinic.scope(staff);
    const term = String(patient || '').trim().slice(0, 200);
    const num = /^\d+$/.test(term) ? Number(term) : 0;
    const matches = await all(`SELECT p.id FROM patients p JOIN customers c ON c.id = p.customer_id WHERE ${s.sql}
      AND (p.id = ? OR (c.first_name || ' ' || c.last_name) ILIKE ? OR c.email ILIKE ?) ORDER BY p.id LIMIT 3`, ...s.params, num, `%${term}%`, `%${term}%`);
    if (!matches.length) return { error: 'No patient you can see matches that.' };
    if (matches.length > 1) return { error: 'More than one patient matches; ask the user which one.', candidates: await Promise.all(matches.map(async (m) => { const p = await clinic.findVisible(staff, m.id); return { number: p.id, name: p.name }; })) };
    const p = await clinic.findVisible(staff, matches[0].id);
    const items = (await clinic.healthItems(p.id)).filter((i) => i.active);
    const notes = (await clinic.notes(p.id)).filter((n) => n.signed_at).slice(0, 3);
    const plans = await all("SELECT id, content_enc, start_date, review_date FROM care_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 3", p.id);
    return {
      number: p.id, name: p.name, age: clinic.age(p.profile.date_of_birth), pronouns: p.profile.pronouns || null, summary: p.profile.summary || null,
      health_items: items.map((i) => ({ category: i.category, ...i.data })),
      recent_signed_notes: notes.map((n) => ({ date: ymd(n.visit_date), kind: n.kind, ...n.body })),
      active_care_plans: plans.map((c) => { const body = vault.open(c.content_enc) || {}; return { title: body.title || 'Care plan', goals: body.goals || null, started: c.start_date ? ymd(c.start_date) : null, review_date: c.review_date ? ymd(c.review_date) : null }; }),
    };
  },
};

async function runTool(name, input, staff) {
  const def = TOOLS.find(([n]) => n === name);
  if (!def || !handlers[name]) return { error: `Unknown tool ${name}.` };
  if (!staff.permissions.has(def[1])) return { error: 'Permission missing for this information.' };
  if (name === 'patient_summary' && !clinic.canSeeAny(staff)) return { error: 'Permission missing for this information.' };
  return handlers[name](input && typeof input === 'object' ? input : {}, staff);
}

// Asks one question (optionally following one earlier exchange). Returns { answer, tools, patientData }.
async function ask(staff, question, previous = null) {
  const c = getClient();
  if (!c) { const e = new Error('The assistant needs ANTHROPIC_API_KEY to be set on the server.'); e.status = 503; throw e; }
  const messages = [];
  if (previous && previous.question && previous.answer) messages.push({ role: 'user', content: previous.question }, { role: 'assistant', content: previous.answer });
  messages.push({ role: 'user', content: question });
  const tools = toolsFor(staff);
  const used = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' }, // keeps answers inside the function time limit
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `${SYSTEM}\nThe person asking is ${staff.name} (role: ${staff.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      tools,
      messages,
    });
    if (response.stop_reason === 'refusal') return { answer: 'The assistant declined to answer this question.', tools: used };
    if (response.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: response.content }); continue; }
    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { answer: text || 'No answer was returned.', tools: used, truncated: response.stop_reason === 'max_tokens' };
    }
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of calls) {
      used.push(call.name);
      let out;
      try { out = await runTool(call.name, call.input, staff); } catch (err) { out = { error: `The tool failed: ${err.message}` }; }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out).slice(0, 60000), ...(out && out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'The question needed too many look-ups. Try asking something narrower.', tools: used };
}

module.exports = { MODEL, TOOLS, SYSTEM, configured, setClient, toolsFor, runTool, ask };
