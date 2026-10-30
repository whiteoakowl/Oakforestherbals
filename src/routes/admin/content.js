'use strict';
// Online Store content: pages, blog posts, navigation menus and uploaded files.
const express = require('express');
const { get, all, run, insert } = require('../../db');
const { upload, saveFile, saveFiles, listFiles, removeFile } = require('../../storage');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, uniqueHandle, asBool, parseTags, asList } = require('../../utils');

const router = express.Router();

/* ---------- Pages ---------- */

router.get('/pages', async (req, res) => {
  res.render('admin/content/pages', { title: 'Pages', pages: await all('SELECT * FROM pages ORDER BY lower(title)') });
});

router.get('/pages/new', async (req, res) => res.render('admin/content/page-edit', { title: 'Add page', page: null }));
router.get('/pages/:id', async (req, res, next) => {
  const page = await get('SELECT * FROM pages WHERE id = ?', toInt(req.params.id));
  return page ? res.render('admin/content/page-edit', { title: page.title, page }) : next();
});

async function savePage(req, res, id) {
  const title = String(req.body.title || '').trim() || 'Untitled page';
  const handle = await uniqueHandle('pages', req.body.handle || title, id || 0);
  const cols = [title, handle, String(req.body.body_html || ''), asBool(req.body.published) ? 1 : 0, String(req.body.seo_title || ''), String(req.body.seo_description || '')];
  if (id) await run("UPDATE pages SET title = ?, handle = ?, body_html = ?, published = ?, seo_title = ?, seo_description = ?, updated_at = now() WHERE id = ?", ...cols, id);
  else id = await insert('INSERT INTO pages (title, handle, body_html, published, seo_title, seo_description) VALUES (?, ?, ?, ?, ?, ?)', ...cols);
  flash(req, 'success', 'Page saved.');
  res.redirect(`/admin/content/pages/${id}`);
}
router.post('/pages/new', async (req, res) => savePage(req, res, null));
router.post('/pages/:id', async (req, res) => savePage(req, res, toInt(req.params.id)));
router.post('/pages/:id/delete', async (req, res) => {
  await run('DELETE FROM pages WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Page deleted.');
  res.redirect('/admin/content/pages');
});

/* ---------- Blog posts ---------- */

router.get('/blog', async (req, res) => {
  res.render('admin/content/articles', { title: 'Blog posts', articles: await all('SELECT * FROM articles ORDER BY published_at DESC') });
});
router.get('/blog/new', async (req, res) => res.render('admin/content/article-edit', { title: 'Add blog post', article: null }));
router.get('/blog/:id', async (req, res, next) => {
  const article = await get('SELECT * FROM articles WHERE id = ?', toInt(req.params.id));
  return article ? res.render('admin/content/article-edit', { title: article.title, article }) : next();
});

async function saveArticle(req, res, id) {
  const b = req.body;
  const title = String(b.title || '').trim() || 'Untitled post';
  const handle = await uniqueHandle('articles', b.handle || title, id || 0);
  const image = (await saveFile(req.file)) || (b.remove_image ? '' : String(b.image || ''));
  // datetime-local values carry no zone; the form labels them as UTC.
  const publishedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.published_at || '') ? new Date(`${b.published_at}:00Z`) : new Date();
  const cols = [title, handle, String(b.author || res.locals.staff.name), String(b.excerpt || ''), String(b.body_html || ''), image,
    parseTags(b.tags).join(', '), asBool(b.published) ? 1 : 0, publishedAt, String(b.seo_title || ''), String(b.seo_description || '')];
  if (id) {
    await run(`UPDATE articles SET title = ?, handle = ?, author = ?, excerpt = ?, body_html = ?, image = ?, tags = ?, published = ?, published_at = ?,
      seo_title = ?, seo_description = ? WHERE id = ?`, ...cols, id);
  } else {
    id = await insert(`INSERT INTO articles (title, handle, author, excerpt, body_html, image, tags, published, published_at, seo_title, seo_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols);
  }
  flash(req, 'success', 'Blog post saved.');
  res.redirect(`/admin/content/blog/${id}`);
}
router.post('/blog/new', upload.single('image_file'), verifyCsrf, async (req, res) => saveArticle(req, res, null));
router.post('/blog/:id', upload.single('image_file'), verifyCsrf, async (req, res) => saveArticle(req, res, toInt(req.params.id)));
router.post('/blog/:id/delete', async (req, res) => {
  await run('DELETE FROM articles WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Blog post deleted.');
  res.redirect('/admin/content/blog');
});

/* ---------- Navigation ---------- */

async function linkTargets() {
  const [collections, pages] = await Promise.all([
    all('SELECT title, handle FROM collections ORDER BY title'),
    all('SELECT title, handle FROM pages ORDER BY title'),
  ]);
  return [
    ['/', 'Home'], ['/collections/all', 'All products'], ['/collections', 'All collections'], ['/blogs/news', 'Blog'], ['/search', 'Search'],
    ...collections.map((c) => [`/collections/${c.handle}`, `Collection: ${c.title}`]),
    ...pages.map((p) => [`/pages/${p.handle}`, `Page: ${p.title}`]),
    ...['refund', 'privacy', 'terms', 'shipping'].map((p) => [`/policies/${p}`, `Policy: ${p}`]),
  ];
}

router.get('/navigation', async (req, res) => {
  const menus = (await all('SELECT * FROM menus ORDER BY id')).map((m) => ({ ...m, items: JSON.parse(m.items || '[]') }));
  res.render('admin/content/navigation', { title: 'Navigation', menus });
});

router.get('/navigation/:id', async (req, res, next) => {
  const menu = await get('SELECT * FROM menus WHERE id = ?', toInt(req.params.id));
  if (!menu) return next();
  menu.items = JSON.parse(menu.items || '[]');
  res.render('admin/content/menu-edit', { title: menu.title, menu, targets: await linkTargets() });
});

router.post('/navigation/new', async (req, res) => {
  const title = String(req.body.title || '').trim() || 'New menu';
  const id = await insert("INSERT INTO menus (handle, title, items) VALUES (?, ?, '[]')", await uniqueHandle('menus', title), title);
  res.redirect(`/admin/content/navigation/${id}`);
});

router.post('/navigation/:id', async (req, res) => {
  // Items post as items[i][title|url|parent]; parent is the index of a top-level item for dropdowns.
  const raw = asList(req.body.items).filter((i) => i && String(i.title || '').trim() && String(i.url || '').trim());
  const top = [];
  const byIndex = new Map();
  raw.forEach((i, idx) => {
    const item = { title: String(i.title).trim(), url: String(i.url).trim(), children: [] };
    byIndex.set(String(idx), item);
    if (i.parent !== undefined && i.parent !== '' && byIndex.has(String(i.parent))) byIndex.get(String(i.parent)).children.push(item);
    else top.push(item);
  });
  await run('UPDATE menus SET title = ?, items = ? WHERE id = ?', String(req.body.title || 'Menu'), JSON.stringify(top), toInt(req.params.id));
  flash(req, 'success', 'Menu saved.');
  res.redirect(`/admin/content/navigation/${req.params.id}`);
});

router.post('/navigation/:id/delete', async (req, res) => {
  await run("DELETE FROM menus WHERE id = ? AND handle NOT IN ('main-menu', 'footer')", toInt(req.params.id));
  res.redirect('/admin/content/navigation');
});

/* ---------- Files ---------- */

router.get('/files', async (req, res) => {
  const files = await listFiles();
  res.render('admin/content/files', { title: 'Files', files });
});

router.post('/files', upload.array('files', 20), verifyCsrf, async (req, res) => {
  await saveFiles(req.files);
  flash(req, 'success', `${(req.files || []).length} file(s) uploaded.`);
  res.redirect('/admin/content/files');
});

router.post('/files/delete', async (req, res) => {
  await removeFile(req.body.name);
  flash(req, 'success', 'File deleted.');
  res.redirect('/admin/content/files');
});

module.exports = router;
