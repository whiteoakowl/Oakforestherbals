'use strict';
// Herbal database: vocabularies, search, profiles, saving and CSV import.
// Ground rules: nothing here invents herb content. Safety and dosage entries require a source;
// research uses (preliminary/clinical) require a source; traditions are never merged.
const { get, all, run, insert, tx } = require('./db');
const { slugify, parseCsv } = require('./utils');

const VOCABULARIES = [
  ['action', 'Herbal actions'],
  ['energetic', 'Energetics'],
  ['taste', 'Tastes'],
  ['body_system', 'Body systems'],
  ['plant_part', 'Plant parts used'],
  ['preparation', 'Preparation methods'],
  ['constituent_class', 'Phytochemical classes'],
];
const VOCAB_KEYS = VOCABULARIES.map(([k]) => k);
// Vocabularies linked directly to herbs (constituent classes are linked through constituents).
const LINKED_VOCABS = ['action', 'energetic', 'taste', 'body_system', 'plant_part', 'preparation'];

const EVIDENCE = [
  ['traditional', 'Traditional use', 'Documented in traditional or historical practice; not established by clinical research.'],
  ['preliminary', 'Preliminary research', 'Laboratory, animal or small/early human studies.'],
  ['clinical', 'Clinical evidence', 'Supported by controlled human clinical trials or systematic reviews.'],
];
const EVIDENCE_KEYS = EVIDENCE.map(([k]) => k);

const SAFETY_KINDS = [
  ['contraindication', 'Contraindication'], ['caution', 'Caution'], ['interaction', 'Drug interaction'],
  ['pregnancy', 'Pregnancy'], ['lactation', 'Lactation'], ['children', 'Children'], ['dosage', 'Dosage reference'],
];
const SAFETY_KEYS = SAFETY_KINDS.map(([k]) => k);

const SOURCE_KINDS = [['book', 'Book'], ['monograph', 'Monograph'], ['article', 'Journal article'], ['review', 'Systematic review'], ['website', 'Website'], ['other', 'Other']];

const NAME_KINDS = [['common', 'Other common name'], ['synonym', 'Botanical synonym'], ['tradition', 'Name within a tradition']];

const TEXT_FIELDS = ['common_name', 'latin_name', 'genus', 'species', 'summary', 'identification', 'native_region', 'distribution', 'habitat', 'cultivation', 'harvesting', 'traditional_use', 'history'];

async function traditions() {
  return all('SELECT * FROM herbal_traditions ORDER BY position, name');
}

// { vocabulary: [ { id, slug, name, grp, tradition_id, tradition_name, herb_count } ] }
async function terms({ counts = false } = {}) {
  const rows = await all(`SELECT t.*, tr.name AS tradition_name, tr.key AS tradition_key
      ${counts ? ", (SELECT COUNT(*) FROM herb_term_links l JOIN herbs h ON h.id = l.herb_id WHERE l.term_id = t.id AND h.status = 'published') AS herb_count" : ''}
    FROM herb_terms t LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id
    ORDER BY t.vocabulary, tr.position NULLS FIRST, t.grp, t.position, t.name`);
  const out = Object.fromEntries(VOCAB_KEYS.map((k) => [k, []]));
  for (const r of rows) (out[r.vocabulary] = out[r.vocabulary] || []).push(r);
  return out;
}

// Groups a vocabulary's terms for display: [{ label, terms }], general terms first.
function grouped(list) {
  const groups = [];
  for (const t of list) {
    const label = [t.tradition_name, t.grp].filter(Boolean).join(' — ') || '';
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push(g = { label, terms: [] });
    g.terms.push(t);
  }
  return groups;
}

/* ---------- Search ---------- */

const FILTER_PARAMS = { action: 'action', energetic: 'energetic', taste: 'taste', system: 'body_system', part: 'plant_part', prep: 'preparation' };
const ids = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);

// Parses a search request into a normalised query object.
function parseQuery(src) {
  const q = {
    q: String(src.q || '').trim().slice(0, 200),
    family: Number(src.family) || 0,
    tradition: Number(src.tradition) || 0,
    constituent: String(src.constituent || '').trim().slice(0, 100),
    class: Number(src.class) || 0,
    letter: /^[A-Z]$/.test(String(src.letter || '')) ? src.letter : '',
    status: ['published', 'draft', 'all'].includes(src.status) ? src.status : 'published',
    favorites: src.favorites === '1',
    sort: src.sort === 'latin' ? 'latin' : 'common',
  };
  for (const key of Object.keys(FILTER_PARAMS)) q[key] = ids(src[key]);
  return q;
}

function toParams(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) { if (v.length) p.set(k, v.join(',')); } else if (v && !(k === 'status' && v === 'published') && !(k === 'sort' && v === 'common')) p.set(k, v === true ? '1' : v);
  }
  return p.toString();
}

const isEmpty = (q) => !q.q && !q.family && !q.tradition && !q.constituent && !q.class && !q.letter && !q.favorites && Object.keys(FILTER_PARAMS).every((k) => !q[k].length);

// Runs a search. Every selected term must apply (AND); free text matches names, synonyms,
// family, constituents, conditions and keywords.
async function search(q, { staffId = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (q.status !== 'all') { where.push('h.status = ?'); params.push(q.status); }
  if (q.q) {
    where.push(`(h.search_vector @@ plainto_tsquery('simple', ?) OR h.search_text ILIKE ?)`);
    params.push(q.q, `%${q.q.toLowerCase()}%`);
  }
  for (const key of Object.keys(FILTER_PARAMS)) {
    for (const termId of q[key]) { where.push('EXISTS (SELECT 1 FROM herb_term_links l WHERE l.herb_id = h.id AND l.term_id = ?)'); params.push(termId); }
  }
  if (q.family) { where.push('h.family_id = ?'); params.push(q.family); }
  if (q.tradition) {
    where.push(`(EXISTS (SELECT 1 FROM herb_tradition_profiles tp WHERE tp.herb_id = h.id AND tp.tradition_id = ?)
      OR EXISTS (SELECT 1 FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id WHERE l.herb_id = h.id AND t.tradition_id = ?))`);
    params.push(q.tradition, q.tradition);
  }
  if (q.constituent) { where.push('EXISTS (SELECT 1 FROM herb_constituents c WHERE c.herb_id = h.id AND c.name ILIKE ?)'); params.push(`%${q.constituent}%`); }
  if (q.class) { where.push('EXISTS (SELECT 1 FROM herb_constituents c WHERE c.herb_id = h.id AND c.class_term_id = ?)'); params.push(q.class); }
  if (q.letter) { where.push('upper(left(h.common_name, 1)) = ?'); params.push(q.letter); }
  if (q.favorites && staffId) { where.push('EXISTS (SELECT 1 FROM herb_favorites f WHERE f.herb_id = h.id AND f.staff_id = ?)'); params.push(staffId); }
  const sql = where.length ? where.join(' AND ') : 'TRUE';
  const total = (await get(`SELECT COUNT(*) AS n FROM herbs h WHERE ${sql}`, ...params)).n;
  const order = q.sort === 'latin' ? 'lower(h.latin_name::text)' : 'lower(h.common_name)';
  const rows = await all(`SELECT h.id, h.slug, h.common_name, h.latin_name, h.status, h.summary, f.name AS family,
      (SELECT url FROM herb_images i WHERE i.herb_id = h.id ORDER BY position, id LIMIT 1) AS image,
      (SELECT string_agg(t.name, ', ' ORDER BY t.position) FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id WHERE l.herb_id = h.id AND t.vocabulary = 'action') AS actions
    FROM herbs h LEFT JOIN plant_families f ON f.id = h.family_id WHERE ${sql} ORDER BY ${order}, h.id LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { total, rows };
}

// An exact common/Latin/synonym name match opens the profile directly.
async function exactMatch(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return (await get('SELECT id, slug FROM herbs WHERE latin_name = ? OR lower(common_name) = lower(?) LIMIT 1', t, t))
    || get('SELECT h.id, h.slug FROM herb_names n JOIN herbs h ON h.id = n.herb_id WHERE n.name = ? ORDER BY h.id LIMIT 1', t);
}

// Autocomplete: herbs (by any name), families and terms starting with the text.
async function suggest(text, { includeDrafts = false } = {}) {
  const t = String(text || '').trim();
  if (t.length < 2) return [];
  const like = `${t}%`;
  const status = includeDrafts ? '' : "AND h.status = 'published'";
  const herbsRows = await all(`SELECT DISTINCT ON (h.id) h.id, h.slug, h.common_name, h.latin_name, n.name AS via FROM herbs h
      LEFT JOIN herb_names n ON n.herb_id = h.id AND n.name ILIKE ?
    WHERE (h.common_name ILIKE ? OR h.latin_name ILIKE ? OR n.id IS NOT NULL) ${status} ORDER BY h.id LIMIT 8`, like, like, like);
  const fam = await all('SELECT id, name FROM plant_families WHERE name ILIKE ? ORDER BY name LIMIT 3', like);
  const tm = await all(`SELECT t.id, t.name, t.vocabulary, tr.name AS tradition FROM herb_terms t LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id
    WHERE t.name ILIKE ? AND t.vocabulary != 'constituent_class' ORDER BY t.vocabulary, t.name LIMIT 5`, like);
  const param = Object.fromEntries(Object.entries(FILTER_PARAMS).map(([k, v]) => [v, k]));
  return [
    ...herbsRows.map((h) => ({ label: `${h.common_name} — ${h.latin_name}${h.via && h.via.toLowerCase() !== h.common_name.toLowerCase() ? ` (${h.via})` : ''}`, url: `/admin/herbs/${h.slug}` })),
    ...fam.map((f) => ({ label: `Family: ${f.name}`, url: `/admin/herbs?family=${f.id}` })),
    ...tm.map((x) => ({ label: `${VOCABULARIES.find(([k]) => k === x.vocabulary)[1].replace(/s$/, '')}: ${x.name}${x.tradition ? ` (${x.tradition})` : ''}`, url: `/admin/herbs?${param[x.vocabulary]}=${x.id}` })),
  ];
}

// Plain-language label for a query, used in history and saved searches.
async function describe(q) {
  const parts = [];
  if (q.q) parts.push(`“${q.q}”`);
  const termIds = Object.keys(FILTER_PARAMS).flatMap((k) => q[k]);
  if (termIds.length) parts.push(...(await all('SELECT name FROM herb_terms WHERE id = ANY(?::int[]) ORDER BY vocabulary, position', `{${termIds.join(',')}}`)).map((r) => r.name));
  if (q.family) { const f = await get('SELECT name FROM plant_families WHERE id = ?', q.family); if (f) parts.push(f.name); }
  if (q.tradition) { const t = await get('SELECT name FROM herbal_traditions WHERE id = ?', q.tradition); if (t) parts.push(t.name); }
  if (q.constituent) parts.push(`contains ${q.constituent}`);
  if (q.class) { const c = await get('SELECT name FROM herb_terms WHERE id = ?', q.class); if (c) parts.push(c.name); }
  if (q.letter) parts.push(`starts with ${q.letter}`);
  if (q.favorites) parts.push('favourites');
  return parts.join(' + ') || 'All herbs';
}

async function recordHistory(staffId, q) {
  if (isEmpty(q)) return;
  const query = toParams(q);
  const label = await describe(q);
  await run('DELETE FROM herb_search_history WHERE staff_id = ? AND query = ?', staffId, query);
  await run('INSERT INTO herb_search_history (staff_id, query, label) VALUES (?, ?, ?)', staffId, query, label);
  await run(`DELETE FROM herb_search_history WHERE staff_id = ? AND id NOT IN (SELECT id FROM herb_search_history WHERE staff_id = ? ORDER BY id DESC LIMIT 15)`, staffId, staffId);
}

/* ---------- Profiles ---------- */

async function profile(slugOrId, { staffId = null } = {}) {
  const h = await get(`SELECT h.*, f.name AS family, f.common_name AS family_common FROM herbs h LEFT JOIN plant_families f ON f.id = h.family_id
    WHERE ${typeof slugOrId === 'number' ? 'h.id' : 'h.slug'} = ?`, slugOrId);
  if (!h) return null;
  const [names, links, profiles, constituents, preparations, uses, safety, images] = await Promise.all([
    all('SELECT n.*, tr.name AS tradition FROM herb_names n LEFT JOIN herbal_traditions tr ON tr.id = n.tradition_id WHERE n.herb_id = ? ORDER BY n.kind, n.name', h.id),
    all(`SELECT l.*, t.vocabulary, t.name, t.grp, t.slug, t.tradition_id, tr.name AS tradition FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id
      LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id WHERE l.herb_id = ? ORDER BY t.vocabulary, tr.position NULLS FIRST, t.grp, t.position`, h.id),
    all('SELECT p.*, tr.name AS tradition FROM herb_tradition_profiles p JOIN herbal_traditions tr ON tr.id = p.tradition_id WHERE p.herb_id = ? ORDER BY tr.position, p.id', h.id),
    all('SELECT c.*, t.name AS class_name FROM herb_constituents c LEFT JOIN herb_terms t ON t.id = c.class_term_id WHERE c.herb_id = ? ORDER BY t.name NULLS LAST, c.name', h.id),
    all('SELECT p.*, t.name AS method FROM herb_preparations p LEFT JOIN herb_terms t ON t.id = p.method_term_id WHERE p.herb_id = ? ORDER BY t.position, p.id', h.id),
    all(`SELECT u.*, tr.name AS tradition, t.name AS body_system FROM herb_uses u LEFT JOIN herbal_traditions tr ON tr.id = u.tradition_id
      LEFT JOIN herb_terms t ON t.id = u.body_system_term_id WHERE u.herb_id = ? ORDER BY u.evidence, u.id`, h.id),
    all('SELECT * FROM herb_safety WHERE herb_id = ? ORDER BY kind, id', h.id),
    all('SELECT * FROM herb_images WHERE herb_id = ? ORDER BY position, id', h.id),
  ]);
  // Every source cited anywhere on the profile, numbered for the reference list.
  const sourceIds = [...new Set([...links, ...profiles, ...constituents, ...preparations, ...uses, ...safety].map((x) => x.source_id).filter(Boolean))];
  const sources = sourceIds.length ? await all('SELECT * FROM herb_sources WHERE id = ANY(?::int[]) ORDER BY authors, title', `{${sourceIds.join(',')}}`) : [];
  const refNo = new Map(sources.map((s, i) => [s.id, i + 1]));
  const byVocab = Object.fromEntries(LINKED_VOCABS.map((v) => [v, links.filter((l) => l.vocabulary === v)]));
  Object.assign(h, { names, links, byVocab, profiles, constituents, preparations, uses, safety, images, sources, refNo });
  h.missing = missingInfo(h);
  if (staffId) {
    h.favorite = Boolean(await get('SELECT 1 FROM herb_favorites WHERE staff_id = ? AND herb_id = ?', staffId, h.id));
    h.myNote = (await get('SELECT note, updated_at FROM herb_staff_notes WHERE staff_id = ? AND herb_id = ?', staffId, h.id)) || null;
  }
  return h;
}

// What a professional reference would expect but this entry doesn't have yet.
function missingInfo(h) {
  const m = [];
  if (!h.family_id) m.push('plant family');
  if (!h.byVocab.plant_part.length) m.push('plant parts used');
  if (!h.byVocab.action.length) m.push('herbal actions');
  if (!h.byVocab.energetic.length) m.push('energetics');
  if (!h.byVocab.taste.length) m.push('taste');
  if (!h.byVocab.body_system.length) m.push('body systems');
  if (!h.safety.some((s) => ['contraindication', 'caution', 'interaction'].includes(s.kind))) m.push('safety information (contraindications, cautions, interactions)');
  if (!h.safety.some((s) => s.kind === 'pregnancy')) m.push('pregnancy safety');
  if (!h.sources.length) m.push('references');
  if (!h.images.length) m.push('photographs');
  return m;
}

// Other published herbs sharing the most actions and body systems.
async function related(herbId, limit = 6) {
  return all(`SELECT h.id, h.slug, h.common_name, h.latin_name, COUNT(*) AS shared
    FROM herb_term_links mine JOIN herb_terms t ON t.id = mine.term_id AND t.vocabulary IN ('action', 'body_system')
    JOIN herb_term_links other ON other.term_id = mine.term_id AND other.herb_id != mine.herb_id
    JOIN herbs h ON h.id = other.herb_id AND h.status = 'published'
    WHERE mine.herb_id = ? GROUP BY h.id ORDER BY shared DESC, lower(h.common_name) LIMIT ?`, herbId, limit);
}

/* ---------- Saving ---------- */

async function familyId(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const existing = await get('SELECT id FROM plant_families WHERE name = ?', n);
  return existing ? existing.id : insert('INSERT INTO plant_families (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name', n);
}

async function uniqueSlug(base, exceptId = 0) {
  const root = slugify(base) || 'herb';
  let slug = root;
  for (let i = 2; await get('SELECT 1 FROM herbs WHERE slug = ? AND id != ?', slug, exceptId); i++) slug = `${root}-${i}`;
  return slug;
}

// Rebuilds the text the search engine matches against.
async function refreshSearch(herbId) {
  const h = await get('SELECT h.*, f.name AS family FROM herbs h LEFT JOIN plant_families f ON f.id = h.family_id WHERE h.id = ?', herbId);
  if (!h) return;
  const parts = [h.common_name, h.latin_name, h.genus, h.species, h.family, h.summary, h.native_region, h.traditional_use];
  for (const r of await all('SELECT name FROM herb_names WHERE herb_id = ?', herbId)) parts.push(r.name);
  for (const r of await all('SELECT t.name FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id WHERE l.herb_id = ?', herbId)) parts.push(r.name);
  for (const r of await all('SELECT name FROM herb_constituents WHERE herb_id = ?', herbId)) parts.push(r.name);
  for (const r of await all('SELECT condition FROM herb_uses WHERE herb_id = ?', herbId)) parts.push(r.condition);
  for (const r of await all('SELECT local_name FROM herb_tradition_profiles WHERE herb_id = ?', herbId)) parts.push(r.local_name);
  const text = parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').slice(0, 20000);
  await run("UPDATE herbs SET search_text = ?, search_vector = to_tsvector('simple', ?) WHERE id = ?", text, text, herbId);
}

// Possible duplicates for a new or renamed herb: same Latin name, or a name that is another herb's synonym.
async function duplicates({ latin_name, common_name }, exceptId = 0) {
  const latin = String(latin_name || '').trim();
  const common = String(common_name || '').trim();
  return all(`SELECT DISTINCT h.id, h.slug, h.common_name, h.latin_name FROM herbs h LEFT JOIN herb_names n ON n.herb_id = h.id
    WHERE h.id != ? AND (h.latin_name = ? OR n.name = ? OR (n.kind = 'synonym' AND n.name = ?) OR (? != '' AND lower(h.common_name) = lower(?)))`,
  exceptId, latin, latin, latin, common, common);
}

// fields: TEXT_FIELDS + family + status; termIds: [id]; names: [{ name, kind, tradition_id }]; constituents: [{ name, class_term_id }]
async function save(id, { fields, family, status, termIds, names, constituents }) {
  return tx(async () => {
    const values = TEXT_FIELDS.map((f) => String(fields[f] || '').trim());
    const fam = await familyId(family);
    const st = status === 'published' ? 'published' : 'draft';
    if (id) {
      const slug = await uniqueSlug(fields.common_name, id);
      await run(`UPDATE herbs SET ${TEXT_FIELDS.map((f) => `${f} = ?`).join(', ')}, family_id = ?, status = ?, slug = ?, updated_at = now() WHERE id = ?`, ...values, fam, st, slug, id);
    } else {
      const slug = await uniqueSlug(fields.common_name);
      id = await insert(`INSERT INTO herbs (${TEXT_FIELDS.join(', ')}, family_id, status, slug) VALUES (${TEXT_FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`, ...values, fam, st, slug);
    }
    if (termIds) {
      const keep = [...new Set(termIds)];
      await run(`DELETE FROM herb_term_links WHERE herb_id = ? AND NOT (term_id = ANY(?::int[]))`, id, `{${keep.join(',')}}`);
      for (const t of keep) await run('INSERT INTO herb_term_links (herb_id, term_id) VALUES (?, ?) ON CONFLICT (herb_id, term_id) DO NOTHING', id, t);
    }
    if (names) {
      await run('DELETE FROM herb_names WHERE herb_id = ?', id);
      for (const n of names) await run('INSERT INTO herb_names (herb_id, name, kind, tradition_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', id, n.name, n.kind, n.tradition_id || null);
    }
    if (constituents) {
      const keepNames = constituents.map((c) => c.name.toLowerCase());
      for (const c of await all('SELECT id, name FROM herb_constituents WHERE herb_id = ?', id)) {
        if (!keepNames.includes(String(c.name).toLowerCase())) await run('DELETE FROM herb_constituents WHERE id = ?', c.id);
      }
      for (const c of constituents) {
        await run(`INSERT INTO herb_constituents (herb_id, name, class_term_id) VALUES (?, ?, ?)
          ON CONFLICT (herb_id, name) DO UPDATE SET class_term_id = COALESCE(EXCLUDED.class_term_id, herb_constituents.class_term_id)`, id, c.name, c.class_term_id || null);
      }
    }
    await refreshSearch(id);
    return id;
  });
}

/* ---------- CSV import / export ---------- */

const CSV_COLUMNS = ['common_name', 'latin_name', 'family', 'genus', 'species', 'other_names', 'synonyms', 'parts_used', 'actions', 'energetics', 'tastes',
  'body_systems', 'preparations', 'constituents', 'summary', 'identification', 'native_region', 'distribution', 'habitat', 'cultivation', 'harvesting', 'traditional_use', 'status'];
const CSV_VOCAB = { parts_used: 'plant_part', actions: 'action', energetics: 'energetic', tastes: 'taste', body_systems: 'body_system', preparations: 'preparation' };
const list = (v) => String(v || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);

// Finds a general (non-tradition) term by name or slug; "Tradition: Term" picks a tradition's term.
function termLookup(allTerms, traditionsList) {
  return (vocab, label) => {
    let text = label.trim();
    let tradId = null;
    const m = text.match(/^([^:]+):\s*(.+)$/);
    if (m) {
      const tr = traditionsList.find((t) => [t.key, t.name.toLowerCase()].includes(m[1].trim().toLowerCase()));
      if (tr) { tradId = tr.id; text = m[2]; }
    }
    const key = text.toLowerCase();
    return (allTerms[vocab] || []).find((t) => (t.tradition_id || null) === tradId
      && [t.slug, t.name.toLowerCase(), t.name.toLowerCase().replace(/\s*\(.*\)$/, '')].includes(key)) || null;
  };
}

/**
 * Imports herbs from CSV text. Rows whose Latin name (or a synonym) already exists are skipped,
 * or merged into the existing herb when merge is true (blank fields filled, names/terms added,
 * nothing overwritten). Unknown terms are reported, never invented.
 */
async function importCsv(text, { merge = false } = {}) {
  const rows = parseCsv(text);
  const report = { created: [], merged: [], skipped: [], errors: [], unknownTerms: [] };
  const allTerms = await terms();
  const lookup = termLookup(allTerms, await traditions());
  for (const [i, raw] of rows.entries()) {
    const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_'), String(v || '').trim()]));
    const line = i + 2;
    if (!row.common_name || !row.latin_name) { report.errors.push(`Row ${line}: common_name and latin_name are required.`); continue; }
    const termIds = [];
    for (const [col, vocab] of Object.entries(CSV_VOCAB)) {
      for (const label of list(row[col])) {
        const t = lookup(vocab, label);
        if (t) termIds.push(t.id); else report.unknownTerms.push(`Row ${line}: ${col} “${label}”`);
      }
    }
    const names = [...list(row.other_names).map((n) => ({ name: n, kind: 'common' })), ...list(row.synonyms).map((n) => ({ name: n, kind: 'synonym' }))];
    const constituents = list(row.constituents).map((n) => ({ name: n }));
    const dupes = await duplicates(row);
    if (dupes.length) {
      if (!merge) { report.skipped.push(`Row ${line}: ${row.latin_name} matches existing ${dupes[0].common_name} (${dupes[0].latin_name}).`); continue; }
      const target = await get('SELECT * FROM herbs WHERE id = ?', dupes[0].id);
      const fields = Object.fromEntries(TEXT_FIELDS.map((f) => [f, target[f] || row[f] || '']));
      const existingTerms = (await all('SELECT term_id FROM herb_term_links WHERE herb_id = ?', target.id)).map((r) => r.term_id);
      const existingNames = (await all('SELECT name, kind, tradition_id FROM herb_names WHERE herb_id = ?', target.id)).map((n) => ({ ...n, name: String(n.name) }));
      const existingCons = (await all('SELECT name, class_term_id FROM herb_constituents WHERE herb_id = ?', target.id)).map((c) => ({ ...c, name: String(c.name) }));
      const fam = target.family_id ? (await get('SELECT name FROM plant_families WHERE id = ?', target.family_id)).name : row.family;
      await save(target.id, {
        fields, family: fam, status: target.status, termIds: [...existingTerms, ...termIds],
        names: [...existingNames, ...names.filter((n) => !existingNames.some((e) => e.name.toLowerCase() === n.name.toLowerCase() && e.kind === n.kind))],
        constituents: [...existingCons, ...constituents.filter((c) => !existingCons.some((e) => e.name.toLowerCase() === c.name.toLowerCase()))],
      });
      report.merged.push(`${target.common_name} (${target.latin_name})`);
      continue;
    }
    const fields = Object.fromEntries(TEXT_FIELDS.map((f) => [f, row[f] || '']));
    await save(null, { fields, family: row.family, status: row.status === 'published' ? 'published' : 'draft', termIds, names, constituents });
    report.created.push(`${row.common_name} (${row.latin_name})`);
  }
  return report;
}

async function exportRows() {
  const herbsRows = await all('SELECT h.*, f.name AS family FROM herbs h LEFT JOIN plant_families f ON f.id = h.family_id ORDER BY lower(h.common_name)');
  const out = [];
  for (const h of herbsRows) {
    const links = await all(`SELECT t.vocabulary, t.name, tr.key AS tradition FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id
      LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id WHERE l.herb_id = ? ORDER BY t.position`, h.id);
    const names = await all('SELECT name, kind FROM herb_names WHERE herb_id = ? ORDER BY name', h.id);
    const cons = await all('SELECT name FROM herb_constituents WHERE herb_id = ? ORDER BY name', h.id);
    const termsOf = (vocab) => links.filter((l) => l.vocabulary === vocab).map((l) => (l.tradition ? `${l.tradition}: ${l.name}` : l.name)).join('; ');
    out.push({
      ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, h[f]])), family: h.family || '', status: h.status,
      other_names: names.filter((n) => n.kind === 'common').map((n) => n.name).join('; '),
      synonyms: names.filter((n) => n.kind === 'synonym').map((n) => n.name).join('; '),
      parts_used: termsOf('plant_part'), actions: termsOf('action'), energetics: termsOf('energetic'), tastes: termsOf('taste'),
      body_systems: termsOf('body_system'), preparations: termsOf('preparation'), constituents: cons.map((c) => c.name).join('; '),
    });
  }
  return out;
}

module.exports = {
  VOCABULARIES, VOCAB_KEYS, LINKED_VOCABS, EVIDENCE, EVIDENCE_KEYS, SAFETY_KINDS, SAFETY_KEYS, SOURCE_KINDS, NAME_KINDS, TEXT_FIELDS,
  FILTER_PARAMS, CSV_COLUMNS, traditions, terms, grouped, parseQuery, toParams, isEmpty, search, exactMatch, suggest, describe, recordHistory,
  profile, related, refreshSearch, duplicates, save, familyId, importCsv, exportRows,
};
