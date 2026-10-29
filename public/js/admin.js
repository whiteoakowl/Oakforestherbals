// Admin interactions: tables, dialogs, save bar, rich text, repeatable rows, theme preview and charts.
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const on = (sel, event, fn) => document.addEventListener(event, (e) => {
    const el = e.target.closest(sel);
    if (el) fn(e, el);
  });

  // Sidebar on small screens
  on('[data-sidebar-toggle]', 'click', () => $('[data-sidebar]').classList.toggle('open'));
  on('[data-open-store]', 'click', (e) => { e.preventDefault(); e.stopPropagation(); window.open('/', '_blank', 'noopener'); });

  // Clickable rows (ignore clicks on inputs/links inside them)
  on('tr[data-href]', 'click', (e, row) => {
    if (e.target.closest('a, button, input, label, select')) return;
    location.href = row.dataset.href;
  });

  // Confirmations
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
  on('[data-confirm-click]', 'click', (e, btn) => { if (!confirm(btn.dataset.confirmClick)) e.preventDefault(); else btn.form && (btn.form.dataset.skipDirty = '1'); });

  // Auto-submitting selects
  $$('form[data-autosubmit] select').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // Dialogs
  on('[data-dialog-open]', 'click', (e, btn) => document.getElementById(btn.dataset.dialogOpen).showModal());
  on('[data-dialog-close]', 'click', (e, btn) => btn.closest('dialog').close());

  // Bulk selection
  const bulkBar = $('[data-bulk-bar]');
  function refreshBulk() {
    if (!bulkBar) return;
    const n = $$('[data-check]:checked').length;
    bulkBar.hidden = n === 0;
    $('[data-bulk-count]').textContent = `${n} selected`;
  }
  on('[data-check-all]', 'change', (e, all) => { $$('[data-check]').forEach((c) => { c.checked = all.checked; }); refreshBulk(); });
  on('[data-check]', 'change', refreshBulk);

  // Copy to clipboard
  on('[data-copy]', 'click', async (e, btn) => {
    await navigator.clipboard.writeText(location.origin + btn.dataset.copy);
    btn.textContent = 'Copied!';
  });

  // Rich text editors: keep the hidden textarea in sync with the editable area.
  $$('[data-rte]').forEach((wrap) => {
    const area = $('[data-rte-area]', wrap);
    const source = $('[data-rte-source]', wrap);
    let htmlMode = false;
    const sync = () => { if (!htmlMode) source.value = area.innerHTML; };
    area.addEventListener('input', () => { sync(); source.dispatchEvent(new Event('input', { bubbles: true })); });
    $$('[data-cmd]', wrap).forEach((btn) => btn.addEventListener('click', () => {
      area.focus();
      let value = btn.dataset.value || null;
      if (btn.dataset.cmd === 'createLink') value = prompt('Link URL', 'https://');
      if (btn.dataset.cmd === 'insertImage') value = prompt('Image URL', 'https://');
      if ((btn.dataset.cmd === 'createLink' || btn.dataset.cmd === 'insertImage') && !value) return;
      document.execCommand(btn.dataset.cmd, false, value);
      sync();
      source.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    $('[data-html-toggle]', wrap).addEventListener('click', (e) => {
      htmlMode = !htmlMode;
      if (htmlMode) source.value = area.innerHTML; else area.innerHTML = source.value;
      source.hidden = !htmlMode;
      area.hidden = htmlMode;
      e.currentTarget.classList.toggle('on', htmlMode);
    });
  });

  // Unsaved changes bar
  $$('form[data-dirty-form]').forEach((form) => {
    const bar = $('[data-save-bar]', form);
    let dirty = false;
    const mark = () => { dirty = true; if (bar) bar.hidden = false; };
    form.addEventListener('input', mark);
    form.addEventListener('change', mark);
    form.addEventListener('submit', () => { dirty = false; });
    window.addEventListener('beforeunload', (e) => { if (dirty && !form.dataset.skipDirty) { e.preventDefault(); e.returnValue = ''; } });
  });

  // Repeatable rows: renumber the first [n] in each field name so indices stay dense.
  function renumber(container, rowSel) {
    $$(rowSel, container).forEach((row, i) => {
      $$('[name]', row).forEach((el) => { el.name = el.name.replace(/\[\d+\]/, `[${i}]`); });
      const num = $('.row-num', row);
      if (num) num.textContent = `#${i}`;
    });
  }
  function addFromTemplate(container, template, rowSel) {
    const index = $$(rowSel, container).length;
    container.insertAdjacentHTML('beforeend', template.innerHTML.replaceAll('__i__', index));
    renumber(container, rowSel);
    return container.lastElementChild;
  }

  // Product options
  const options = $('[data-options]');
  if (options) {
    const addBtn = $('[data-add-option]');
    const sync = () => { addBtn.hidden = $$('[data-option-row]', options).length >= 3; };
    addBtn.addEventListener('click', () => {
      const row = addFromTemplate(options, $('[data-option-template]'), '[data-option-row]');
      $('input', row).focus();
      sync();
    });
    on('[data-remove-option]', 'click', (e, btn) => {
      btn.closest('[data-option-row]').remove();
      renumber(options, '[data-option-row]');
      sync();
      options.closest('form').dispatchEvent(new Event('change'));
    });
  }

  // Margin from price and cost
  const cost = $('[data-cost]');
  if (cost) {
    const price = cost.form.elements.price;
    const out = $('[data-margin]');
    const calc = () => {
      const p = parseFloat(price.value); const c = parseFloat(cost.value);
      out.textContent = p > 0 && c >= 0 ? `Profit ${(p - c).toFixed(2)} · Margin ${(((p - c) / p) * 100).toFixed(1)}%` : '';
    };
    price.addEventListener('input', calc); cost.addEventListener('input', calc); calc();
  }

  // Selected image names
  on('[data-image-input]', 'change', (e, input) => {
    $('[data-image-names]').textContent = [...input.files].map((f) => f.name).join(', ');
  });

  // SEO preview title follows the title field
  const titleInput = $('[data-title-input]');
  const seoPreview = $('[data-seo-preview-title]');
  const seoTitle = $('[data-seo-title]');
  if (titleInput && seoPreview) {
    const upd = () => { seoPreview.textContent = (seoTitle && seoTitle.value) || titleInput.value || 'Product title'; };
    titleInput.addEventListener('input', upd);
    if (seoTitle) seoTitle.addEventListener('input', upd);
  }

  // Collections: manual vs automated
  $$('[data-kind]').forEach((r) => r.addEventListener('change', () => {
    $$('[data-kind-panel]').forEach((p) => { p.hidden = p.dataset.kindPanel !== r.value; });
  }));
  const rules = $('[data-rules]');
  if (rules) {
    $('[data-add-rule]').addEventListener('click', () => {
      const first = $('[data-rule-row]', rules);
      const clone = first.cloneNode(true);
      $$('input', clone).forEach((i) => { i.value = ''; });
      rules.append(clone);
      renumber(rules, '[data-rule-row]');
    });
    on('[data-remove-rule]', 'click', (e, btn) => {
      if ($$('[data-rule-row]', rules).length > 1) btn.closest('[data-rule-row]').remove();
      renumber(rules, '[data-rule-row]');
    });
  }
  const picker = $('[data-product-picker]');
  if (picker) {
    const list = $('[data-picked]');
    picker.addEventListener('change', () => {
      const opt = picker.selectedOptions[0];
      if (!opt.value || $(`li[data-id="${opt.value}"]`, list)) { picker.value = ''; return; }
      const li = document.createElement('li');
      li.dataset.id = opt.value;
      li.innerHTML = '<input type="hidden" name="product_ids"><span class="drag">⋮⋮</span><span class="grow"></span>'
        + '<button type="button" class="btn btn-plain" data-move="-1" aria-label="Move up">↑</button>'
        + '<button type="button" class="btn btn-plain" data-move="1" aria-label="Move down">↓</button>'
        + '<button type="button" class="btn btn-plain" data-unpick aria-label="Remove">✕</button>';
      $('input', li).value = opt.value;
      $('.grow', li).textContent = opt.dataset.title;
      list.append(li);
      picker.value = '';
      list.closest('form').dispatchEvent(new Event('change'));
    });
    on('[data-unpick]', 'click', (e, btn) => { btn.closest('li').remove(); list.closest('form').dispatchEvent(new Event('change')); });
    on('[data-move]', 'click', (e, btn) => {
      const li = btn.closest('li');
      if (btn.dataset.move === '-1' && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
      if (btn.dataset.move === '1' && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
      list.closest('form').dispatchEvent(new Event('change'));
    });
  }

  // Create-order product lines
  const lines = $('[data-lines]');
  if (lines) {
    $('[data-add-line]').addEventListener('click', () => {
      const clone = $('[data-line-row]', lines).cloneNode(true);
      clone.querySelector('select').value = '';
      clone.querySelector('input').value = '1';
      lines.append(clone);
      renumber(lines, '[data-line-row]');
    });
    on('[data-remove-line]', 'click', (e, btn) => {
      if ($$('[data-line-row]', lines).length > 1) btn.closest('[data-line-row]').remove();
      renumber(lines, '[data-line-row]');
    });
  }

  // Navigation menu items
  const menuItems = $('[data-menu-items]');
  if (menuItems) {
    $('[data-add-menu-item]').addEventListener('click', () => {
      const row = addFromTemplate(menuItems, $('[data-menu-template]'), '[data-menu-row]');
      $('input', row).focus();
    });
    on('[data-remove-row]', 'click', (e, btn) => { btn.closest('[data-menu-row]').remove(); renumber(menuItems, '[data-menu-row]'); });
  }

  // Discounts
  const kind = $('[data-discount-kind]');
  if (kind) kind.addEventListener('change', () => { $('[data-discount-value]').hidden = kind.value === 'free_shipping'; });
  on('[data-generate-code]', 'click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    $('[data-code-input]').value = [...bytes].map((b) => chars[b % chars.length]).join('');
  });

  // Theme editor preview
  const preview = $('[data-preview]');
  if (preview) {
    on('[data-preview-size]', 'click', (e, btn) => $('[data-preview-frame]').classList.toggle('mobile', btn.dataset.previewSize === 'mobile'));
    const page = $('[data-preview-page]');
    page.addEventListener('change', () => { preview.src = page.value; });
    // Live color/font preview before saving: set CSS variables inside the same-origin iframe.
    const form = $('[data-theme-form]');
    const varMap = { color_primary: '--color-primary', color_accent: '--color-accent', color_background: '--color-bg', color_surface: '--color-surface', color_text: '--color-text' };
    form.addEventListener('input', (e) => {
      const doc = preview.contentDocument;
      if (!doc) return;
      if (varMap[e.target.name]) {
        doc.documentElement.style.setProperty(varMap[e.target.name], e.target.value);
        const code = e.target.parentElement.querySelector('code');
        if (code) code.textContent = e.target.value;
      }
      if (e.target.name === 'button_radius') doc.documentElement.style.setProperty('--radius', `${e.target.value}px`);
    });
  }

  // Chart tooltips (hover and keyboard focus)
  $$('[data-chart]').forEach((chart) => {
    const tip = $('[data-chart-tip]', chart);
    const show = (g) => {
      const box = g.getBoundingClientRect();
      const host = chart.getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.style.left = `${Math.min(Math.max(box.left - host.left + box.width / 2, 80), host.width - 80)}px`;
      tip.style.top = '40px';
      tip.hidden = false;
    };
    $$('.bar-g', chart).forEach((g) => {
      g.addEventListener('mouseenter', () => show(g));
      g.addEventListener('focus', () => show(g));
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
      g.addEventListener('blur', () => { tip.hidden = true; });
    });
  });

  // Toasts fade out
  $$('.toast').forEach((t) => setTimeout(() => t.remove(), 5000));
})();
