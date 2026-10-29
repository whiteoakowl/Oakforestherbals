// Storefront behaviour: mobile menu, variant picker, quantity steppers, predictive search, checkout helpers.
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Mobile menu
  const toggle = $('[data-menu-toggle]');
  const menu = $('[data-menu]');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Auto-submit filter/sort forms
  $$('form[data-autosubmit] select').forEach((el) => el.addEventListener('change', () => el.form.submit()));

  // Confirm destructive actions
  $$('form[data-confirm]').forEach((form) => form.addEventListener('submit', (e) => {
    if (!confirm(form.dataset.confirm)) e.preventDefault();
  }));

  // Prevent double-submitting payment
  $$('[data-submit-once]').forEach((btn) => btn.form.addEventListener('submit', () => {
    setTimeout(() => { btn.disabled = true; btn.textContent = 'Processing…'; }, 0);
  }));

  // Quantity steppers
  $$('[data-qty-step]').forEach((btn) => btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    input.value = Math.max(1, (parseInt(input.value, 10) || 1) + Number(btn.dataset.qtyStep));
  }));

  // Product variant picker
  const product = $('[data-product]');
  const variantsEl = $('[data-variants]');
  if (product && variantsEl) {
    const variants = JSON.parse(variantsEl.textContent);
    const currency = ($('[data-price]').textContent.match(/^[^\d-]*/) || [''])[0];
    const fmt = (c) => currency + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const idInput = $('[data-variant-id]');
    const button = $('[data-add-button]');
    const note = $('[data-stock-note]');

    const selectedOptions = () => $$('[data-option]:checked').sort((a, b) => a.dataset.option - b.dataset.option).map((i) => i.value);

    function update() {
      const chosen = selectedOptions();
      const variant = variants.find((v) => v.options.every((o, i) => o === chosen[i]));
      // Mark option values that can't be bought with the other current selections.
      $$('[data-option]').forEach((input) => {
        const idx = Number(input.dataset.option);
        const probe = chosen.slice();
        probe[idx] = input.value;
        const match = variants.find((v) => v.options.every((o, i) => o === probe[i]));
        input.closest('.pill').classList.toggle('unavailable', !match || !match.available);
      });
      if (!variant) {
        button.disabled = true;
        button.textContent = 'Unavailable';
        return;
      }
      idInput.value = variant.id;
      $('[data-price]').textContent = fmt(variant.price);
      const onSale = variant.compare_at_price && variant.compare_at_price > variant.price;
      $('[data-compare]').hidden = !onSale;
      $('[data-sale-badge]').hidden = !onSale;
      if (onSale) $('[data-compare]').textContent = fmt(variant.compare_at_price);
      button.disabled = !variant.available;
      button.textContent = variant.available ? 'Add to cart' : 'Sold out';
      note.textContent = variant.available && variant.inventory !== null && variant.inventory > 0 && variant.inventory <= 5
        ? `Only ${variant.inventory} left in stock` : '';
      const url = new URL(location.href);
      url.searchParams.set('variant', variant.id);
      history.replaceState(null, '', url);
    }
    $$('[data-option]').forEach((input) => input.addEventListener('change', update));
    if (variants.length > 1) update();

    // Gallery thumbnails
    const main = $('[data-main-image]');
    $$('[data-thumb]').forEach((thumb) => thumb.addEventListener('click', () => {
      main.src = thumb.dataset.thumb;
      $$('[data-thumb]').forEach((t) => t.classList.toggle('active', t === thumb));
    }));
  }

  // Predictive search
  const search = $('[data-predictive-search]');
  const results = $('[data-predictive-results]');
  if (search && results) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      timer = setTimeout(async () => {
        const res = await fetch(`/search/suggest.json?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        results.replaceChildren();
        for (const p of data.products) {
          const a = document.createElement('a');
          a.href = p.url;
          if (p.image) { const img = document.createElement('img'); img.src = p.image; img.alt = ''; a.append(img); }
          const text = document.createElement('span');
          text.innerHTML = '<strong></strong><br><small></small>';
          text.querySelector('strong').textContent = p.title;
          text.querySelector('small').textContent = p.price;
          a.append(text);
          results.append(a);
        }
        if (!data.products.length) { const s = document.createElement('div'); s.className = 'muted small'; s.style.padding = '8px'; s.textContent = 'No products found. Press enter to search everything.'; results.append(s); }
        results.hidden = false;
      }, 180);
    });
    document.addEventListener('click', (e) => { if (!search.parentElement.contains(e.target)) results.hidden = true; });
  }

  // Checkout billing address toggle
  const billingFields = $('[data-billing-fields]');
  $$('[data-billing-toggle]').forEach((r) => r.addEventListener('change', () => {
    billingFields.hidden = r.value !== 'no' || !r.checked;
  }));
})();
