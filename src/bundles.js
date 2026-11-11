'use strict';
// Bundles: a variant made of other variants (e.g. "Sleep kit" = 1 tea + 1 tincture). A bundle has
// no stock of its own — it is available while its components are, and selling one takes the
// components' stock (and their production lots, at their actual cost).
const { all } = require('./db');

const intArray = (ids) => `{${ids.map((id) => Number(id) | 0).join(',')}}`;

// Map of bundle variant id -> its components with their current stock.
async function componentsFor(variantIds) {
  const map = new Map();
  if (!variantIds.length) return map;
  const rows = await all(`SELECT bc.bundle_variant_id, bc.component_variant_id AS variant_id, bc.quantity, v.inventory_qty, v.track_inventory, v.continue_selling,
      v.cost, v.price, v.title AS variant_title, p.title, p.status
    FROM bundle_components bc JOIN variants v ON v.id = bc.component_variant_id JOIN products p ON p.id = v.product_id
    WHERE bc.bundle_variant_id = ANY(?::int[]) ORDER BY p.title, v.position`, intArray(variantIds));
  for (const r of rows) {
    if (!map.has(r.bundle_variant_id)) map.set(r.bundle_variant_id, []);
    map.get(r.bundle_variant_id).push(r);
  }
  return map;
}

// How many bundles the components allow (Infinity when no component is stock-tracked).
function available(components) {
  let n = Infinity;
  for (const c of components) {
    if (c.status === 'archived') return 0;
    if (c.track_inventory && !c.continue_selling) n = Math.min(n, Math.floor(Math.max(0, c.inventory_qty) / c.quantity));
  }
  return n;
}

// Gives bundle variants a stock level worked out from their components, so every place that checks
// availability (product pages, cart, collections) treats them correctly.
async function applyStock(variants) {
  const map = await componentsFor(variants.map((v) => v.id));
  for (const v of variants) {
    const comps = map.get(v.id);
    if (!comps) continue;
    const n = available(comps);
    v.bundle_components = comps;
    v.track_inventory = n === Infinity ? 0 : 1;
    v.continue_selling = 0;
    v.inventory_qty = n === Infinity ? 0 : n;
    if (v.cost === null || v.cost === undefined) v.cost = comps.every((c) => c.cost !== null) ? comps.reduce((s, c) => s + c.cost * c.quantity, 0) : null;
  }
  return variants;
}

module.exports = { componentsFor, available, applyStock };
