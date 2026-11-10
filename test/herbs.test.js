'use strict';
// Phase 4: herbal database. Uses fictional plants so the test suite makes no claims about real herbs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run } = require('../src/db');

let ctx;
let owner;
let reader;
const term = async (vocab, slug, tradition = null) => (await get(`SELECT t.id FROM herb_terms t LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id
  WHERE t.vocabulary = ? AND t.slug = ? AND tr.key IS NOT DISTINCT FROM ?`, vocab, slug, tradition)).id;

async function addHerb(fields, termIds = []) {
  const body = { status: 'published', ...fields };
  const pairs = Object.entries(body).flatMap(([k, v]) => [].concat(v).map((x) => [k, x]));
  for (const id of termIds) pairs.push(['terms', String(id)]);
  const page = await owner.get('/admin/herbs/new');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  pairs.push(['_csrf', csrf]);
  const res = await fetch(`${ctx.base}/admin/herbs/new`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(pairs).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  await owner.post('/admin/settings/staff', { name: 'Pat Herbalist', email: 'pat@example.com', password: 'password123', role: 'practitioner' }, '/admin/settings/staff');
  reader = new Client(ctx.base);
  await reader.post('/admin/login', { email: 'pat@example.com', password: 'password123', next: '/admin' }, '/admin/login');
});
after(() => ctx.close());

test('standard vocabularies ship, with traditions kept separate', async () => {
  assert.equal((await get("SELECT COUNT(*) AS n FROM herb_terms WHERE vocabulary = 'action'")).n, 26);
  assert.equal((await get("SELECT COUNT(*) AS n FROM herb_terms WHERE vocabulary = 'body_system'")).n, 14);
  assert.deepEqual((await all('SELECT key FROM herbal_traditions ORDER BY position')).map((t) => t.key), ['western', 'ayurveda', 'tcm']);
  assert.notEqual(await term('energetic', 'warm'), await term('energetic', 'warm', 'tcm'), 'TCM "warm" is its own term');
  assert.equal((await get("SELECT COUNT(*) AS n FROM herb_terms t JOIN herbal_traditions tr ON tr.id = t.tradition_id WHERE tr.key = 'ayurveda' AND t.vocabulary = 'taste'")).n, 6);
  assert.equal((await get('SELECT COUNT(*) AS n FROM herbs')).n, 0, 'no herb entries are invented');
  assert.match((await owner.get('/admin/herbs')).text, /The herbal database is empty/);
});

let alpha;
test('add herbs, then combine filters (all must match)', async () => {
  const [warm, cool, bitter, digestive, nervous, carminative, nervine, root] = await Promise.all([
    term('energetic', 'warm'), term('energetic', 'cool'), term('taste', 'bitter'), term('body_system', 'digestive'), term('body_system', 'nervous'),
    term('action', 'carminative'), term('action', 'nervine'), term('plant_part', 'root')]);
  let res = await addHerb({ common_name: 'Alpha Root', latin_name: 'Exemplia alpha', family: 'Exempliaceae', synonyms: 'Exemplia primaria', other_names: 'First root',
    constituents: 'alphanol | flavonoids\nbetaine-x', tradition_names: 'tcm: Jia Gen' }, [warm, bitter, digestive, carminative, root, await term('energetic', 'warm', 'tcm')]);
  assert.match(res.location, /\/admin\/herbs\/alpha-root$/);
  alpha = await get("SELECT * FROM herbs WHERE slug = 'alpha-root'");
  await addHerb({ common_name: 'Beta Leaf', latin_name: 'Exemplia beta', family: 'Exempliaceae' }, [warm, bitter, nervous, nervine]);
  await addHerb({ common_name: 'Gamma Flower', latin_name: 'Specimena gamma', family: 'Specimenaceae' }, [cool, digestive, carminative]);
  await addHerb({ common_name: 'Delta Bark', latin_name: 'Specimena delta', family: 'Specimenaceae', status: 'draft' }, [warm, bitter, digestive, carminative]);

  const names = async (qs, client = owner) => [...(await client.get(`/admin/herbs?${qs}`)).text.matchAll(/<strong>([A-Z][a-z]+ [A-Z][a-z]+)<\/strong><\/a>/g)].map((m) => m[1]);
  assert.deepEqual(await names(`energetic=${warm}&taste=${bitter}&system=${digestive}&action=${carminative}`), ['Alpha Root'], 'warm + bitter + digestive + carminative');
  assert.deepEqual(await names(`system=${nervous}&action=${nervine}`), ['Beta Leaf']);
  assert.deepEqual(await names(`action=${carminative}`), ['Alpha Root', 'Gamma Flower'], 'drafts are not in results by default');
  assert.deepEqual(await names(`action=${carminative}&status=all`), ['Alpha Root', 'Delta Bark', 'Gamma Flower']);
  const fam = await get("SELECT id FROM plant_families WHERE name = 'Exempliaceae'");
  assert.deepEqual(await names(`family=${fam.id}`), ['Alpha Root', 'Beta Leaf']);
  assert.deepEqual(await names('q=Exempliaceae&exact=0'), ['Alpha Root', 'Beta Leaf'], 'free text matches the family');
  assert.deepEqual(await names('q=alphanol'), ['Alpha Root'], 'free text matches constituents');
  assert.deepEqual(await names('constituent=alphanol'), ['Alpha Root']);
  const tcm = await get("SELECT id FROM herbal_traditions WHERE key = 'tcm'");
  assert.deepEqual(await names(`tradition=${tcm.id}`), ['Alpha Root']);
  assert.deepEqual(await names('letter=G'), ['Gamma Flower']);
  // A practitioner (view only) never sees drafts, even when asking for them.
  assert.deepEqual(await names(`action=${carminative}&status=all`, reader), ['Alpha Root', 'Gamma Flower']);
  assert.equal((await reader.get('/admin/herbs/delta-bark')).status, 404);
});

test('exact Latin names and synonyms open the profile; autocomplete matches synonyms', async () => {
  assert.equal((await owner.get('/admin/herbs?q=Exemplia%20alpha')).location, '/admin/herbs/alpha-root');
  assert.equal((await owner.get('/admin/herbs?q=exemplia%20primaria')).location, '/admin/herbs/alpha-root', 'synonym');
  assert.equal((await owner.get('/admin/herbs?q=alpha%20root')).location, '/admin/herbs/alpha-root', 'common name, any case');
  assert.equal((await owner.get('/admin/herbs?q=Jia%20Gen')).location, '/admin/herbs/alpha-root', 'tradition name');
  const s = JSON.parse((await owner.get('/admin/herbs/suggest.json?q=exemplia%20pri')).text);
  assert.equal(s[0].url, '/admin/herbs/alpha-root');
  const f = JSON.parse((await owner.get('/admin/herbs/suggest.json?q=Specimen')).text);
  assert.ok(f.some((x) => x.label === 'Family: Specimenaceae'));
  const t = JSON.parse((await owner.get('/admin/herbs/suggest.json?q=Carmin')).text);
  assert.ok(t.some((x) => /Carminative/.test(x.label) && /action=/.test(x.url)));
});

test('the profile shows classification by tradition and flags missing information', async () => {
  const page = await owner.get('/admin/herbs/alpha-root');
  assert.equal(page.status, 200);
  assert.match(page.text, /Exemplia alpha/);
  assert.match(page.text, /Traditional Chinese Medicine — Nature \(si qi\)/);
  assert.match(page.text, /Warm \(wen\)/);
  assert.match(page.text, /No safety information has been entered/);
  assert.match(page.text, /Missing information:<\/strong>.*safety information/);
  assert.match(page.text, /Gamma Flower/, 'related herbs share actions or body systems');
  assert.doesNotMatch(page.text.split('Related herbs')[1], /Beta Leaf/, 'no shared action or body system');
});

test('safety and research must cite a source; traditional use may not', async () => {
  const from = '/admin/herbs/alpha-root';
  await owner.post('/admin/herbs/alpha-root/safety', { kind: 'pregnancy', description: 'Test caution text', evidence: 'traditional' }, from);
  assert.equal((await get('SELECT COUNT(*) AS n FROM herb_safety')).n, 0);
  await assert.rejects(run("INSERT INTO herb_safety (herb_id, kind, description) VALUES (?, 'caution', 'x')", alpha.id), /null value|not-null|violates/);
  await owner.post('/admin/herbs/sources/new', { kind: 'book', title: 'Test Materia Medica', authors: 'Example, A.', year: '2020' }, '/admin/herbs/sources/new');
  const src = await get("SELECT id FROM herb_sources WHERE title = 'Test Materia Medica'");
  await owner.post('/admin/herbs/alpha-root/safety', { kind: 'pregnancy', description: 'Test caution text', evidence: 'traditional', source_id: src.id }, from);
  assert.equal((await get('SELECT COUNT(*) AS n FROM herb_safety')).n, 1);
  await owner.post('/admin/herbs/alpha-root/uses', { evidence: 'clinical', description: 'Test finding' }, from);
  assert.equal((await get("SELECT COUNT(*) AS n FROM herb_uses WHERE evidence = 'clinical'")).n, 0, 'research needs a source');
  await assert.rejects(run("INSERT INTO herb_uses (herb_id, evidence, description) VALUES (?, 'preliminary', 'x')", alpha.id), /check/i);
  await owner.post('/admin/herbs/alpha-root/uses', { evidence: 'traditional', condition: 'Test complaint', description: 'Traditionally described use (test)' }, from);
  await owner.post('/admin/herbs/alpha-root/uses', { evidence: 'preliminary', description: 'Lab study (test)', source_id: src.id }, from);
  const tcm = await get("SELECT id FROM herbal_traditions WHERE key = 'tcm'");
  await owner.post('/admin/herbs/alpha-root/profiles', { tradition_id: tcm.id, local_name: 'Jia Gen', description: 'Described in its own terms (test).', source_id: src.id }, from);
  const page = await owner.get(from);
  assert.match(page.text, /Test caution text/);
  assert.match(page.text, /Example, A\. \(2020\)\. <em>Test Materia Medica<\/em>/);
  assert.match(page.text, /href="#ref-1">\[1\]/);
  assert.doesNotMatch(page.text, /No safety information has been entered/);
  assert.equal((await reader.get('/admin/herbs?q=Test%20complaint')).location, null, 'condition text is searchable');
  assert.match((await reader.get('/admin/herbs?q=Test%20complaint')).text, /Alpha Root/);
  // A cited source can't be deleted.
  await owner.post(`/admin/herbs/sources/${src.id}/delete`, {}, '/admin/herbs/sources');
  assert.ok(await get('SELECT 1 FROM herb_sources WHERE id = ?', src.id));
});

test('favourites, private notes, saved searches and history are per person', async () => {
  await reader.post('/admin/herbs/alpha-root/favorite', {}, '/admin/herbs/alpha-root');
  await reader.post('/admin/herbs/alpha-root/note', { note: 'Pat private note' }, '/admin/herbs/alpha-root');
  assert.match((await reader.get('/admin/herbs/alpha-root')).text, /Pat private note/);
  assert.doesNotMatch((await owner.get('/admin/herbs/alpha-root')).text, /Pat private note/, 'notes are private to their author');
  assert.match((await reader.get('/admin/herbs?favorites=1')).text, /Alpha Root/);
  assert.doesNotMatch((await owner.get('/admin/herbs?favorites=1')).text, /Alpha Root<\/strong>/);
  const warm = await term('energetic', 'warm');
  await reader.get(`/admin/herbs?energetic=${warm}`);
  await reader.post('/admin/herbs/saved', { save_name: 'Warming herbs', query: `energetic=${warm}` }, '/admin/herbs');
  const page = await reader.get('/admin/herbs');
  assert.match(page.text, /Warming herbs/);
  assert.match(page.text, />Warm<\/a>/, 'recent searches are listed by what was searched');
});

test('CSV import creates herbs, detects duplicates, reports unknown terms, and can merge', async () => {
  const csv = [
    'common_name,latin_name,family,synonyms,actions,energetics,tastes,body_systems,parts_used,constituents',
    'Epsilon Seed,Probum epsilon,Probaceae,,Nervine;Sedative,Cool;tcm: Cold (han),Bitter,Nervous,Seed,epsilonine',
    'Zeta Berry,Probum zeta,Probaceae,Probum zetoides,Tonic;Made-up action,,,,Fruit,',
    'Duplicate by Latin,Exemplia alpha,,,,,,,,',
    'Duplicate by synonym,Exemplia primaria,,,,,,,,',
    ',Missing common,,,,,,,,',
  ].join('\n');
  const upload = async (body, merge) => {
    const page = await owner.get('/admin/herbs/import');
    const form = new FormData();
    form.append('_csrf', page.text.match(/name="_csrf" value="([^"]+)"/)[1]);
    if (merge) form.append('merge', '1');
    form.append('file', new Blob([body], { type: 'text/csv' }), 'herbs.csv');
    const res = await fetch(`${ctx.base}/admin/herbs/import`, { method: 'POST', body: form, headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    return res.text();
  };
  const report = await upload(csv, false);
  assert.match(report, /<strong>2<\/strong> created/);
  assert.match(report, /<strong>2<\/strong> skipped/);
  assert.match(report, /Made-up action/);
  assert.match(report, /common_name and latin_name are required/);
  const eps = await get("SELECT id, status FROM herbs WHERE latin_name = 'Probum epsilon'");
  assert.equal(eps.status, 'draft', 'imports start as drafts');
  const linked = (await all('SELECT t.slug, tr.key FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id LEFT JOIN herbal_traditions tr ON tr.id = t.tradition_id WHERE l.herb_id = ? ORDER BY t.slug', eps.id)).map((r) => (r.key ? `${r.key}:${r.slug}` : r.slug));
  assert.deepEqual(linked, ['bitter', 'cool', 'nervine', 'nervous', 'tcm:cold', 'sedative', 'seed'].sort((a, b) => a.replace(/^tcm:/, '').localeCompare(b.replace(/^tcm:/, ''))));
  // Merge fills blanks and adds terms without overwriting.
  await upload('common_name,latin_name,summary,actions\nIgnored name,Exemplia alpha,Merged summary,Tonic', true);
  const merged = await get("SELECT common_name, summary FROM herbs WHERE latin_name = 'Exemplia alpha'");
  assert.equal(merged.common_name, 'Alpha Root');
  assert.equal(merged.summary, 'Merged summary');
  assert.ok(await get("SELECT 1 FROM herb_term_links l JOIN herb_terms t ON t.id = l.term_id WHERE l.herb_id = ? AND t.slug = 'tonic'", alpha.id));
  const exp = await owner.get('/admin/herbs/export.csv');
  assert.match(exp.text, /^common_name,latin_name,family/);
  assert.match(exp.text, /Probum epsilon/);
  assert.match(exp.text, /tcm: Cold \(han\)/);
});

test('bulk edit, duplicate warning, categories and permissions', async () => {
  const ids = (await all("SELECT id FROM herbs WHERE latin_name LIKE 'Probum%'")).map((r) => String(r.id));
  const tonic = await term('action', 'tonic');
  await owner.post('/admin/herbs/bulk', { action: 'publish', ids }, '/admin/herbs');
  assert.equal((await get("SELECT COUNT(*) AS n FROM herbs WHERE latin_name LIKE 'Probum%' AND status = 'published'")).n, 2);
  await owner.post('/admin/herbs/bulk', { action: 'add_term', term_id: tonic, ids }, '/admin/herbs');
  assert.equal((await get('SELECT COUNT(*) AS n FROM herb_term_links WHERE term_id = ?', tonic)).n, 3);
  // Same common name as an existing herb: warned, not silently added.
  const res = await addHerb({ common_name: 'Alpha Root', latin_name: 'Exemplia alterna' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Possible duplicate/);
  assert.equal(await get("SELECT 1 FROM herbs WHERE latin_name = 'Exemplia alterna'"), undefined);
  // Same Latin name: refused.
  await addHerb({ common_name: 'Another', latin_name: 'Exemplia alpha' });
  assert.equal((await get("SELECT COUNT(*) AS n FROM herbs WHERE latin_name = 'Exemplia alpha'")).n, 1);
  // Categories: add a term; a used term can't be deleted.
  await owner.post('/admin/herbs/terms', { vocabulary: 'action', name: 'Test Action' }, '/admin/herbs/terms');
  assert.ok(await get("SELECT 1 FROM herb_terms WHERE slug = 'test-action'"));
  await owner.post(`/admin/herbs/terms/${tonic}/delete`, {}, '/admin/herbs/terms');
  assert.ok(await get('SELECT 1 FROM herb_terms WHERE id = ?', tonic));
  for (const url of ['/admin/herbs/browse', '/admin/herbs/sources', '/admin/herbs/terms', '/admin/herbs/import', '/admin/herbs/new', '/admin/herbs/alpha-root/edit']) {
    assert.equal((await owner.get(url)).status, 200, url);
  }
  // View-only and no-access roles.
  assert.equal((await reader.get('/admin/herbs/browse')).status, 200);
  for (const url of ['/admin/herbs/new', '/admin/herbs/alpha-root/edit', '/admin/herbs/import', '/admin/herbs/terms', '/admin/herbs/export.csv']) {
    assert.equal((await reader.get(url)).status, 403, url);
  }
  await reader.post('/admin/herbs/alpha-root/delete', {}, '/admin/herbs/alpha-root');
  assert.ok(await get("SELECT 1 FROM herbs WHERE slug = 'alpha-root'"));
  await owner.post('/admin/settings/staff', { name: 'Cass Service', email: 'cass@example.com', password: 'password123', role: 'customer_service' }, '/admin/settings/staff');
  const cs = new Client(ctx.base);
  await cs.post('/admin/login', { email: 'cass@example.com', password: 'password123', next: '/admin' }, '/admin/login');
  assert.equal((await cs.get('/admin/herbs')).status, 403);
});
