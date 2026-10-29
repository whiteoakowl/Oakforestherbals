'use strict';
// Online Store content: pages, blog posts, navigation menus and uploaded files.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { get, all, run } = require('../../db');
const { upload, fileUrl, UPLOAD_DIR } = require('../../uploads');
const { flash, verifyCsrf } = require('../../middleware');
const { toInt, uniqueHandle, asBool, parseTags, asList } = require('../../utils');

const router = express.Router();

/* ---------- Pages ---------- */

router.get('/pages', (req, res) => {
  res.render('admin/content/pages', { title: 'Pages', pages: all('SELECT * FROM pages ORDER BY title COLLATE NOCASE') });
});

router.get('/pages/new', (req, res) => res.render('admin/content/page-edit', { title: 'Add page', page: null }));
router.get('/pages/:id', (req, res, next) => {
  const page = get('SELECT * FROM pages WHERE id = ?', toInt(req.params.id));
  return page ? res.render('admin/content/page-edit', { title: page.title, page }) : next();
});

function savePage(req, res, id) {
  const title = String(req.body.title || '').trim() || 'Untitled page';
  const handle = uniqueHandle('pages', req.body.handle || title, id || 0);
  const cols = [title, handle, String(req.body.body_html || ''), asBool(req.body.published) ? 1 : 0, String(req.body.seo_title || ''), String(req.body.seo_description || '')];
  if (id) run("UPDATE pages SET title = ?, handle = ?, body_html = ?, published = ?, seo_title = ?, seo_description = ?, updated_at = datetime('now') WHERE id = ?", ...cols, id);
  else id = Number(run('INSERT INTO pages (title, handle, body_html, published, seo_title, seo_description) VALUES (?, ?, ?, ?, ?, ?)', ...cols).lastInsertRowid);
  flash(req, 'success', 'Page saved.');
  res.redirect(`/admin/content/pages/${id}`);
}
router.post('/pages/new', (req, res) => savePage(req, res, null));
router.post('/pages/:id', (req, res) => savePage(req, res, toInt(req.params.id)));
router.post('/pages/:id/delete', (req, res) => {
  run('DELETE FROM pages WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Page deleted.');
  res.redirect('/admin/content/pages');
});

/* ---------- Blog posts ---------- */

router.get('/blog', (req, res) => {
  res.render('admin/content/articles', { title: 'Blog posts', articles: all('SELECT * FROM articles ORDER BY published_at DESC') });
});
router.get('/blog/new', (req, res) => res.render('admin/content/article-edit', { title: 'Add blog post', article: null }));
router.get('/blog/:id', (req, res, next) => {
  const article = get('SELECT * FROM articles WHERE id = ?', toInt(req.params.id));
  return article ? res.render('admin/content/article-edit', { title: article.title, article }) : next();
});

function saveArticle(req, res, id) {
  const b = req.body;
  const title = String(b.title || '').trim() || 'Untitled post';
  const handle = uniqueHandle('articles', b.handle || title, id || 0);
  const image = req.file ? fileUrl(req.file) : (b.remove_image ? '' : String(b.image || ''));
  const publishedAt = b.published_at ? String(b.published_at).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const cols = [title, handle, String(b.author || res.locals.staff.name), String(b.excerpt || ''), String(b.body_html || ''), image,
    parseTags(b.tags).join(', '), asBool(b.published) ? 1 : 0, publishedAt, String(b.seo_title || ''), String(b.seo_description || '')];
  if (id) {
    run(`UPDATE articles SET title = ?, handle = ?, author = ?, excerpt = ?, body_html = ?, image = ?, tags = ?, published = ?, published_at = ?,
      seo_title = ?, seo_description = ? WHERE id = ?`, ...cols, id);
  } else {
    id = Number(run(`INSERT INTO articles (title, handle, author, excerpt, body_html, image, tags, published, published_at, seo_title, seo_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols).lastInsertRowid);
  }
  flash(req, 'success', 'Blog post saved.');
  res.redirect(`/admin/content/blog/${id}`);
}
router.post('/blog/new', upload.single('image_file'), verifyCsrf, (req, res) => saveArticle(req, res, null));
router.post('/blog/:id', upload.single('image_file'), verifyCsrf, (req, res) => saveArticle(req, res, toInt(req.params.id)));
router.post('/blog/:id/delete', (req, res) => {
  run('DELETE FROM articles WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Blog post deleted.');
  res.redirect('/admin/content/blog');
});

/* ---------- Navigation ---------- */

function linkTargets() {
  return [
    ['/', 'Home'], ['/collections/all', 'All products'], ['/collections', 'All collections'], ['/blogs/news', 'Blog'], ['/search', 'Search'],
    ...all('SELECT title, handle FROM collections ORDER BY title').map((c) => [`/collections/${c.handle}`, `Collection: ${c.title}`]),
    ...all('SELECT title, handle FROM pages ORDER BY title').map((p) => [`/pages/${p.handle}`, `Page: ${p.title}`]),
    ...['refund', 'privacy', 'terms', 'shipping'].map((p) => [`/policies/${p}`, `Policy: ${p}`]),
  ];
}

router.get('/navigation', (req, res) => {
  const menus = all('SELECT * FROM menus ORDER BY id').map((m) => ({ ...m, items: JSON.parse(m.items || '[]') }));
  res.render('admin/content/navigation', { title: 'Navigation', menus });
});

router.get('/navigation/:id', (req, res, next) => {
  const menu = get('SELECT * FROM menus WHERE id = ?', toInt(req.params.id));
  if (!menu) return next();
  menu.items = JSON.parse(menu.items || '[]');
  res.render('admin/content/menu-edit', { title: menu.title, menu, targets: linkTargets() });
});

router.post('/navigation/new', (req, res) => {
  const title = String(req.body.title || '').trim() || 'New menu';
  const id = Number(run("INSERT INTO menus (handle, title, items) VALUES (?, ?, '[]')", uniqueHandle('menus', title), title).lastInsertRowid);
  res.redirect(`/admin/content/navigation/${id}`);
});

router.post('/navigation/:id', (req, res) => {
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
  run('UPDATE menus SET title = ?, items = ? WHERE id = ?', String(req.body.title || 'Menu'), JSON.stringify(top), toInt(req.params.id));
  flash(req, 'success', 'Menu saved.');
  res.redirect(`/admin/content/navigation/${req.params.id}`);
});

router.post('/navigation/:id/delete', (req, res) => {
  run("DELETE FROM menus WHERE id = ? AND handle NOT IN ('main-menu', 'footer')", toInt(req.params.id));
  res.redirect('/admin/content/navigation');
});

/* ---------- Files ---------- */

router.get('/files', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter((f) => !f.startsWith('.')).map((name) => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, url: `/uploads/${name}`, size: stat.size, created: stat.mtime };
  }).sort((a, b) => b.created - a.created);
  res.render('admin/content/files', { title: 'Files', files });
});

router.post('/files', upload.array('files', 20), verifyCsrf, (req, res) => {
  flash(req, 'success', `${(req.files || []).length} file(s) uploaded.`);
  res.redirect('/admin/content/files');
});

router.post('/files/delete', (req, res) => {
  const name = path.basename(String(req.body.name || ''));
  const target = path.join(UPLOAD_DIR, name);
  if (name && fs.existsSync(target)) fs.unlinkSync(target);
  flash(req, 'success', 'File deleted.');
  res.redirect('/admin/content/files');
});

module.exports = router;
