'use strict';
// Herbalist → Herbal database: search engine, profiles, and administration.
const express = require('express');
const { get, all, run, insert, tx } = require('../../db');
const herbs = require('../../herbs');
const audit = require('../../audit');
const storage = require('../../storage');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, paginate, csvRow } = require('../../utils');

const router = express.Router();

router.use((req, res, next) => {
  const can = res.locals.can;
  if (!can('herbs.view') && !can('herbs.manage')) {
    audit.record(req, 'access.denied', { details: { permission: 'herbs.view', method: req.method, path: req.originalUrl.split('?')[0] } });
    return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role does not include the herbal database.' });
  }
  Object.assign(res.locals, {
    VOCABULARIES: herbs.VOCABULARIES, EVIDENCE: herbs.EVIDENCE, SAFETY_KINDS: herbs.SAFETY_KINDS, SOURCE_KINDS: herbs.SOURCE_KINDS,
    FILTER_PARAMS: herbs.FILTER_PARAMS, grouped: herbs.grouped, canManageHerbs: can('herbs.manage'),
  });
  next();
});

function manage(req, res, next) {
  if (res.locals.can('herbs.manage')) return next();
  audit.record(req, 'access.denied', { details: { permission: 'herbs.manage', method: req.method, path: req.originalUrl.split('?')[0] } });
  return res.status(403).render('admin/error', { title: 'Permission required', message: 'Your role can search the herbal database but not edit it.' });
}

const text = (v, max = 20000) => String(v || '').trim().slice(0, max);
const lines = (v) => String(v || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const sourceOrNull = async (v) => {
  const id = toInt(v);
  return id && await get('SELECT 1 FROM herb_sources WHERE id = ?', id) ? id : null;
};

/* ---------- Search ---------- */

router.get('/', async (req, res) => {
  const staffId = res.locals.staff.id;
  const q = herbs.parseQuery(req.query);
  if (!res.locals.canManageHerbs) q.status = 'published';
  // A bare name that exactly matches a herb (common, Latin or synonym) opens its profile.
  if (q.q && herbs.isEmpty({ ...q, q: '' }) && req.query.exact !== '0') {
    const hit = await herbs.exactMatch(q.q);
    if (hit && (q.status !== 'published' || (await get("SELECT 1 FROM herbs WHERE id = ? AND status = 'published'", hit.id)))) {
      await herbs.recordHistory(staffId, q);
      return res.redirect(`/admin/herbs/${hit.slug}`);
    }
  }
  const total = (await herbs.search(q, { staffId, limit: 0 })).total;
  const pager = paginate(total, req.query.page, 30);
  const { rows } = await herbs.search(q, { staffId, limit: pager.perPage, offset: pager.offset });
  await herbs.recordHistory(staffId, q);
  const [allTerms, families, traditions, history, saved] = await Promise.all([
    herbs.terms(), all('SELECT f.id, f.name, COUNT(h.id) AS n FROM plant_families f LEFT JOIN herbs h ON h.family_id = f.id GROUP BY f.id ORDER BY f.name'),
    herbs.traditions(), all('SELECT * FROM herb_search_history WHERE staff_id = ? ORDER BY id DESC LIMIT 8', staffId),
    all('SELECT * FROM herb_saved_searches WHERE staff_id = ? ORDER BY lower(name)', staffId),
  ]);
  const totalHerbs = (await get('SELECT COUNT(*) AS n FROM herbs')).n;
  res.render('admin/herbs/index', {
    title: 'Herbal database', q, rows, total, pager, allTerms, families, traditions, history, saved, totalHerbs,
    queryString: herbs.toParams(q), label: await herbs.describe(q), empty: herbs.isEmpty(q),
  });
});

router.get('/suggest.json', async (req, res) => {
  res.json(await herbs.suggest(req.query.q, { includeDrafts: res.locals.canManageHerbs }));
});

router.get('/browse', async (req, res) => {
  const [allTerms, families, traditions, letters] = await Promise.all([
    herbs.terms({ counts: true }),
    all("SELECT f.id, f.name, COUNT(h.id) AS n FROM plant_families f JOIN herbs h ON h.family_id = f.id AND h.status = 'published' GROUP BY f.id ORDER BY f.name"),
    all(`SELECT tr.*, (SELECT COUNT(DISTINCT herb_id) FROM herb_tradition_profiles p WHERE p.tradition_id = tr.id) AS n FROM herbal_traditions tr ORDER BY position`),
    all("SELECT upper(left(common_name, 1)) AS l, COUNT(*) AS n FROM herbs WHERE status = 'published' GROUP BY l ORDER BY l"),
  ]);
  res.render('admin/herbs/browse', { title: 'Browse herbs', allTerms, families, traditions, letters });
});

router.post('/saved', async (req, res) => {
  const name = text(req.body.name || req.body.save_name, 100);
  const query = herbs.toParams(herbs.parseQuery(Object.fromEntries(new URLSearchParams(String(req.body.query || '')))));
  if (!name || !query) { flash(req, 'error', 'Name the search, and run one first.'); return res.redirect(`/admin/herbs?${query}`); }
  await insert('INSERT INTO herb_saved_searches (staff_id, name, query) VALUES (?, ?, ?)', res.locals.staff.id, name, query);
  flash(req, 'success', 'Search saved.');
  res.redirect(`/admin/herbs?${query}`);
});

router.post('/saved/:id/delete', async (req, res) => {
  await run('DELETE FROM herb_saved_searches WHERE id = ? AND staff_id = ?', toInt(req.params.id), res.locals.staff.id);
  res.redirect('/admin/herbs');
});

/* ---------- Sources (references) ---------- */

function readSource(body) {
  return {
    kind: herbs.SOURCE_KINDS.some(([k]) => k === body.kind) ? body.kind : 'book',
    title: text(body.title, 500), authors: text(body.authors, 500), year: text(body.year, 20), publisher: text(body.publisher, 300),
    url: /^https?:\/\//i.test(String(body.url || '').trim()) ? text(body.url, 1000) : '', doi: text(body.doi, 200), isbn: text(body.isbn, 40), notes: text(body.notes, 2000),
  };
}
const SOURCE_COLS = ['kind', 'title', 'authors', 'year', 'publisher', 'url', 'doi', 'isbn', 'notes'];

router.get('/sources', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const sources = await all(`SELECT s.*,
      (SELECT COUNT(*) FROM herb_safety x WHERE x.source_id = s.id) + (SELECT COUNT(*) FROM herb_uses x WHERE x.source_id = s.id)
      + (SELECT COUNT(*) FROM herb_tradition_profiles x WHERE x.source_id = s.id) + (SELECT COUNT(*) FROM herb_preparations x WHERE x.source_id = s.id)
      + (SELECT COUNT(*) FROM herb_constituents x WHERE x.source_id = s.id) AS citations
    FROM herb_sources s WHERE (? = '' OR s.title ILIKE ? OR s.authors ILIKE ?) ORDER BY lower(s.authors), lower(s.title)`, q, `%${q}%`, `%${q}%`);
  res.render('admin/herbs/sources', { title: 'References', sources, q });
});

router.get('/sources/new', manage, (req, res) => res.render('admin/herbs/source-edit', { title: 'Add reference', source: null, back: String(req.query.back || '') }));

router.post('/sources/new', manage, async (req, res) => {
  const s = readSource(req.body);
  if (!s.title) { flash(req, 'error', 'A reference needs a title.'); return res.redirect('/admin/herbs/sources/new'); }
  const id = await insert(`INSERT INTO herb_sources (${SOURCE_COLS.join(', ')}) VALUES (${SOURCE_COLS.map(() => '?').join(', ')})`, ...SOURCE_COLS.map((c) => s[c]));
  flash(req, 'success', 'Reference added.');
  const back = String(req.body.back || '');
  res.redirect(/^\/admin\/herbs\/[\w-]+$/.test(back) ? back : `/admin/herbs/sources/${id}`);
});

router.get('/sources/:id', manage, async (req, res, next) => {
  const source = await get('SELECT * FROM herb_sources WHERE id = ?', toInt(req.params.id));
  if (!source) return next();
  res.render('admin/herbs/source-edit', { title: source.title, source, back: '' });
});

router.post('/sources/:id', manage, async (req, res, next) => {
  const id = toInt(req.params.id);
  if (!await get('SELECT 1 FROM herb_sources WHERE id = ?', id)) return next();
  const s = readSource(req.body);
  if (!s.title) { flash(req, 'error', 'A reference needs a title.'); return res.redirect(`/admin/herbs/sources/${id}`); }
  await run(`UPDATE herb_sources SET ${SOURCE_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...SOURCE_COLS.map((c) => s[c]), id);
  flash(req, 'success', 'Reference saved.');
  res.redirect('/admin/herbs/sources');
});

router.post('/sources/:id/delete', manage, async (req, res) => {
  const id = toInt(req.params.id);
  try {
    await run('DELETE FROM herb_sources WHERE id = ?', id);
    flash(req, 'success', 'Reference deleted.');
  } catch {
    flash(req, 'error', 'This reference is cited by safety or research entries, so it can\'t be deleted.');
  }
  res.redirect('/admin/herbs/sources');
});

/* ---------- Vocabularies ---------- */

router.get('/terms', manage, async (req, res) => {
  res.render('admin/herbs/terms', { title: 'Categories and vocabularies', allTerms: await herbs.terms({ counts: true }), traditions: await herbs.traditions() });
});

router.post('/terms', manage, async (req, res) => {
  const vocabulary = herbs.VOCAB_KEYS.includes(req.body.vocabulary) ? req.body.vocabulary : null;
  const name = text(req.body.name, 100);
  const tradition = toInt(req.body.tradition_id) || null;
  const slug = require('../../utils').slugify(name);
  if (!vocabulary || !name || !slug) { flash(req, 'error', 'Choose a list and enter a name.'); return res.redirect('/admin/herbs/terms'); }
  if (await get('SELECT 1 FROM herb_terms WHERE vocabulary = ? AND slug = ? AND tradition_id IS NOT DISTINCT FROM ?', vocabulary, slug, tradition)) {
    flash(req, 'error', 'That term already exists in this list.'); return res.redirect('/admin/herbs/terms');
  }
  await insert('INSERT INTO herb_terms (vocabulary, slug, name, grp, description, tradition_id, position) VALUES (?, ?, ?, ?, ?, ?, 999)',
    vocabulary, slug, name, text(req.body.grp, 60), text(req.body.description, 1000), tradition);
  await audit.record(req, 'herb_term.created', { entityType: 'herb_term', entityId: slug, details: { vocabulary, name } });
  flash(req, 'success', `“${name}” added.`);
  res.redirect('/admin/herbs/terms');
});

router.post('/terms/:id', manage, async (req, res) => {
  const name = text(req.body.name, 100);
  if (name) await run('UPDATE herb_terms SET name = ?, description = ? WHERE id = ?', name, text(req.body.description, 1000), toInt(req.params.id));
  flash(req, 'success', 'Term saved.');
  res.redirect('/admin/herbs/terms');
});

router.post('/terms/:id/delete', manage, async (req, res) => {
  const id = toInt(req.params.id);
  const used = (await get('SELECT COUNT(*) AS n FROM herb_term_links WHERE term_id = ?', id)).n;
  if (used) flash(req, 'error', `This term is used by ${used} herb(s); remove it from them first.`);
  else { await run('DELETE FROM herb_terms WHERE id = ?', id); flash(req, 'success', 'Term deleted.'); }
  res.redirect('/admin/herbs/terms');
});

/* ---------- Import / export / bulk ---------- */

router.get('/import', manage, (req, res) => res.render('admin/herbs/import', { title: 'Import herbs', report: null, columns: herbs.CSV_COLUMNS }));

router.post('/import', storage.csvUpload.single('file'), verifyCsrf, manage, async (req, res) => {
  if (!req.file) { flash(req, 'error', 'Choose a CSV file.'); return res.redirect('/admin/herbs/import'); }
  const report = await herbs.importCsv(req.file.buffer.toString('utf8'), { merge: req.body.merge === '1' });
  await audit.record(req, 'herbs.imported', { details: { created: report.created.length, merged: report.merged.length, skipped: report.skipped.length, errors: report.errors.length } });
  res.render('admin/herbs/import', { title: 'Import herbs', report, columns: herbs.CSV_COLUMNS });
});

router.get('/template.csv', manage, (req, res) => {
  res.attachment('herb-import-template.csv').type('text/csv').send(`${csvRow(herbs.CSV_COLUMNS)}\n`);
});

router.get('/export.csv', manage, async (req, res) => {
  const rows = await herbs.exportRows();
  const out = [csvRow(herbs.CSV_COLUMNS), ...rows.map((r) => csvRow(herbs.CSV_COLUMNS.map((c) => r[c] ?? '')))];
  res.attachment('herbs.csv').type('text/csv').send(out.join('\n'));
});

router.post('/bulk', manage, async (req, res) => {
  const idsList = [].concat(req.body.ids || []).flatMap((v) => String(v).split(',')).map(toInt).filter(Boolean);
  const action = String(req.body.action || '');
  const back = `/admin/herbs?${String(req.body.query || '')}`;
  if (!idsList.length) { flash(req, 'error', 'Select at least one herb.'); return res.redirect(back); }
  const termId = toInt(req.body.term_id);
  await tx(async () => {
    for (const id of idsList) {
      if (action === 'publish' || action === 'draft') await run('UPDATE herbs SET status = ?, updated_at = now() WHERE id = ?', action === 'publish' ? 'published' : 'draft', id);
      if (action === 'add_term' && termId) await run('INSERT INTO herb_term_links (herb_id, term_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, termId);
      if (action === 'remove_term' && termId) await run('DELETE FROM herb_term_links WHERE herb_id = ? AND term_id = ?', id, termId);
      if (action.endsWith('_term')) await herbs.refreshSearch(id);
    }
  });
  flash(req, 'success', `${idsList.length} herb(s) updated.`);
  res.redirect(back);
});

/* ---------- Create / edit ---------- */

async function formData() {
  return { allTerms: await herbs.terms(), traditions: await herbs.traditions(), families: await all('SELECT name FROM plant_families ORDER BY name') };
}

async function readForm(body) {
  const traditions = await herbs.traditions();
  const fields = Object.fromEntries(herbs.TEXT_FIELDS.map((f) => [f, text(body[f], f === 'common_name' || f === 'latin_name' ? 200 : 20000)]));
  const termIds = [].concat(body.terms || []).map(toInt).filter(Boolean);
  const names = [
    ...lines(body.other_names).map((n) => ({ name: n.slice(0, 200), kind: 'common' })),
    ...lines(body.synonyms).map((n) => ({ name: n.slice(0, 200), kind: 'synonym' })),
    ...lines(body.tradition_names).map((l) => {
      const m = l.match(/^([^:]+):\s*(.+)$/);
      const tr = m && traditions.find((t) => [t.key, t.name.toLowerCase()].includes(m[1].trim().toLowerCase()));
      return { name: (tr ? m[2] : l).slice(0, 200), kind: 'tradition', tradition_id: tr ? tr.id : null };
    }),
  ];
  const classes = (await herbs.terms()).constituent_class;
  const constituents = lines(body.constituents).map((l) => {
    const [name, cls] = l.split('|').map((x) => x.trim());
    const c = cls && classes.find((t) => [t.slug, t.name.toLowerCase()].includes(cls.toLowerCase()));
    return { name: name.slice(0, 200), class_term_id: c ? c.id : null };
  }).filter((c) => c.name);
  return { fields, family: text(body.family, 120), status: body.status, termIds, names, constituents };
}

router.get('/new', manage, async (req, res) => {
  res.render('admin/herbs/edit', { title: 'Add herb', herb: null, dupes: [], ...await formData() });
});

router.post('/new', manage, async (req, res) => {
  const form = await readForm(req.body);
  if (!form.fields.common_name || !form.fields.latin_name) {
    flash(req, 'error', 'Common name and Latin name are required.');
    return res.render('admin/herbs/edit', { title: 'Add herb', herb: null, draft: req.body, dupes: [], ...await formData() });
  }
  const dupes = await herbs.duplicates(form.fields);
  if (dupes.some((d) => String(d.latin_name).toLowerCase() === form.fields.latin_name.toLowerCase())) {
    flash(req, 'error', `${form.fields.latin_name} is already in the database.`);
    return res.redirect(`/admin/herbs/${dupes[0].slug}`);
  }
  if (dupes.length && req.body.confirm_duplicate !== '1') {
    return res.render('admin/herbs/edit', { title: 'Add herb', herb: null, draft: req.body, dupes, ...await formData() });
  }
  const id = await herbs.save(null, form);
  await audit.record(req, 'herb.created', { entityType: 'herb', entityId: id, details: { latin_name: form.fields.latin_name } });
  const h = await get('SELECT slug FROM herbs WHERE id = ?', id);
  flash(req, 'success', 'Herb added. Add safety information and references from its profile.');
  res.redirect(`/admin/herbs/${h.slug}`);
});

async function herbParam(req, res, next) {
  const h = await get('SELECT * FROM herbs WHERE slug = ?', String(req.params.slug));
  if (!h || (h.status !== 'published' && !res.locals.canManageHerbs)) {
    return res.status(404).render('admin/error', { title: 'Not found', message: 'This herb is not in the database.' });
  }
  req.herb = h;
  next();
}

router.get('/:slug/edit', manage, herbParam, async (req, res) => {
  const herb = await herbs.profile(req.herb.id);
  res.render('admin/herbs/edit', { title: `Edit ${herb.common_name}`, herb, dupes: [], ...await formData() });
});

router.post('/:slug/edit', manage, herbParam, async (req, res) => {
  const form = await readForm(req.body);
  if (!form.fields.common_name || !form.fields.latin_name) { flash(req, 'error', 'Common name and Latin name are required.'); return res.redirect(`/admin/herbs/${req.herb.slug}/edit`); }
  const clash = await get('SELECT slug FROM herbs WHERE latin_name = ? AND id != ?', form.fields.latin_name, req.herb.id);
  if (clash) { flash(req, 'error', `${form.fields.latin_name} is already used by another herb.`); return res.redirect(`/admin/herbs/${req.herb.slug}/edit`); }
  await herbs.save(req.herb.id, form);
  await audit.record(req, 'herb.updated', { entityType: 'herb', entityId: req.herb.id });
  const h = await get('SELECT slug FROM herbs WHERE id = ?', req.herb.id);
  flash(req, 'success', 'Herb saved.');
  res.redirect(`/admin/herbs/${h.slug}`);
});

router.post('/:slug/delete', manage, herbParam, async (req, res) => {
  await run('DELETE FROM herbs WHERE id = ?', req.herb.id);
  await audit.record(req, 'herb.deleted', { entityType: 'herb', entityId: req.herb.id, details: { latin_name: String(req.herb.latin_name) } });
  flash(req, 'success', `${req.herb.common_name} deleted.`);
  res.redirect('/admin/herbs');
});

/* ---------- Profile ---------- */

router.get('/:slug', herbParam, async (req, res) => {
  const herb = await herbs.profile(req.herb.id, { staffId: res.locals.staff.id });
  const [related, sources, traditions, allTerms] = await Promise.all([
    herbs.related(herb.id), all('SELECT id, title, authors, year FROM herb_sources ORDER BY lower(authors), lower(title)'), herbs.traditions(), herbs.terms(),
  ]);
  res.render('admin/herbs/show', { title: `${herb.common_name} (${herb.latin_name})`, herb, related, sources, traditions, allTerms });
});

router.post('/:slug/favorite', herbParam, async (req, res) => {
  const staffId = res.locals.staff.id;
  if (await get('SELECT 1 FROM herb_favorites WHERE staff_id = ? AND herb_id = ?', staffId, req.herb.id)) await run('DELETE FROM herb_favorites WHERE staff_id = ? AND herb_id = ?', staffId, req.herb.id);
  else await run('INSERT INTO herb_favorites (staff_id, herb_id) VALUES (?, ?)', staffId, req.herb.id);
  res.redirect(`/admin/herbs/${req.herb.slug}`);
});

// Private materia medica notes: visible only to the staff member who wrote them.
router.post('/:slug/note', herbParam, async (req, res) => {
  const note = text(req.body.note, 20000);
  if (!note) await run('DELETE FROM herb_staff_notes WHERE staff_id = ? AND herb_id = ?', res.locals.staff.id, req.herb.id);
  else {
    await run(`INSERT INTO herb_staff_notes (staff_id, herb_id, note) VALUES (?, ?, ?)
      ON CONFLICT (staff_id, herb_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`, res.locals.staff.id, req.herb.id, note);
  }
  flash(req, 'success', 'Your private note was saved.');
  res.redirect(`/admin/herbs/${req.herb.slug}#my-notes`);
});

const backTo = (req, anchor) => `/admin/herbs/${req.herb.slug}${anchor ? `#${anchor}` : ''}`;

router.post('/:slug/safety', manage, herbParam, async (req, res) => {
  const kind = herbs.SAFETY_KEYS.includes(req.body.kind) ? req.body.kind : null;
  const description = text(req.body.description, 5000);
  const source = await sourceOrNull(req.body.source_id);
  const evidence = herbs.EVIDENCE_KEYS.includes(req.body.evidence) ? req.body.evidence : 'traditional';
  if (!kind || !description) { flash(req, 'error', 'Choose the type and describe the safety information.'); return res.redirect(backTo(req, 'safety')); }
  if (!source) { flash(req, 'error', 'Safety and dosage information must cite a reference. Add the reference first if it isn\'t listed.'); return res.redirect(backTo(req, 'safety')); }
  await insert('INSERT INTO herb_safety (herb_id, kind, description, evidence, source_id, entered_by) VALUES (?, ?, ?, ?, ?, ?)', req.herb.id, kind, description, evidence, source, res.locals.staff.name);
  await audit.record(req, 'herb.safety_added', { entityType: 'herb', entityId: req.herb.id, details: { kind, source } });
  res.redirect(backTo(req, 'safety'));
});

router.post('/:slug/uses', manage, herbParam, async (req, res) => {
  const evidence = herbs.EVIDENCE_KEYS.includes(req.body.evidence) ? req.body.evidence : 'traditional';
  const description = text(req.body.description, 5000);
  const source = await sourceOrNull(req.body.source_id);
  if (!description) { flash(req, 'error', 'Describe the use.'); return res.redirect(backTo(req, 'uses')); }
  if (evidence !== 'traditional' && !source) { flash(req, 'error', 'Research findings must cite a reference.'); return res.redirect(backTo(req, 'uses')); }
  const system = toInt(req.body.body_system_term_id);
  const okSystem = system && await get("SELECT 1 FROM herb_terms WHERE id = ? AND vocabulary = 'body_system'", system);
  await insert('INSERT INTO herb_uses (herb_id, evidence, tradition_id, body_system_term_id, condition, description, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    req.herb.id, evidence, toInt(req.body.tradition_id) || null, okSystem ? system : null, text(req.body.condition, 200), description, source);
  await herbs.refreshSearch(req.herb.id);
  res.redirect(backTo(req, 'uses'));
});

router.post('/:slug/profiles', manage, herbParam, async (req, res) => {
  const tradition = toInt(req.body.tradition_id);
  const description = text(req.body.description, 20000);
  if (!tradition || !description) { flash(req, 'error', 'Choose a tradition and enter its description.'); return res.redirect(backTo(req, 'traditions')); }
  await insert('INSERT INTO herb_tradition_profiles (herb_id, tradition_id, local_name, description, source_id) VALUES (?, ?, ?, ?, ?)',
    req.herb.id, tradition, text(req.body.local_name, 200), description, await sourceOrNull(req.body.source_id));
  await herbs.refreshSearch(req.herb.id);
  res.redirect(backTo(req, 'traditions'));
});

router.post('/:slug/preparations', manage, herbParam, async (req, res) => {
  const method = toInt(req.body.method_term_id);
  const okMethod = method && await get("SELECT 1 FROM herb_terms WHERE id = ? AND vocabulary = 'preparation'", method);
  if (!okMethod) { flash(req, 'error', 'Choose a preparation method.'); return res.redirect(backTo(req, 'preparations')); }
  await insert('INSERT INTO herb_preparations (herb_id, method_term_id, plant_part, menstruum, ratio, notes, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    req.herb.id, method, text(req.body.plant_part, 100), text(req.body.menstruum, 200), text(req.body.ratio, 100), text(req.body.notes, 2000), await sourceOrNull(req.body.source_id));
  res.redirect(backTo(req, 'preparations'));
});

router.post('/:slug/images', storage.upload.single('image'), verifyCsrf, manage, herbParam, async (req, res) => {
  if (!req.file) { flash(req, 'error', 'Choose an image (JPG, PNG, WebP, GIF, AVIF).'); return res.redirect(backTo(req, 'photos')); }
  const url = await storage.saveFile(req.file);
  const pos = ((await get('SELECT MAX(position) AS m FROM herb_images WHERE herb_id = ?', req.herb.id)).m ?? -1) + 1;
  await insert('INSERT INTO herb_images (herb_id, url, alt, credit, position) VALUES (?, ?, ?, ?, ?)', req.herb.id, url,
    text(req.body.alt, 300) || `${req.herb.common_name} (${req.herb.latin_name})`, text(req.body.credit, 300), pos);
  res.redirect(backTo(req, 'photos'));
});

// Removing an entry from one of the profile's lists.
const REMOVABLE = { safety: 'herb_safety', uses: 'herb_uses', profiles: 'herb_tradition_profiles', preparations: 'herb_preparations', images: 'herb_images' };
router.post('/:slug/:kind/:id/delete', manage, herbParam, async (req, res, next) => {
  const table = REMOVABLE[req.params.kind];
  if (!table) return next();
  await run(`DELETE FROM ${table} WHERE id = ? AND herb_id = ?`, toInt(req.params.id), req.herb.id);
  await audit.record(req, 'herb.entry_removed', { entityType: 'herb', entityId: req.herb.id, details: { kind: req.params.kind, id: toInt(req.params.id) } });
  await herbs.refreshSearch(req.herb.id);
  res.redirect(backTo(req, req.params.kind === 'profiles' ? 'traditions' : req.params.kind === 'images' ? 'photos' : req.params.kind));
});

module.exports = router;
