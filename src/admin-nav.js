'use strict';
// Admin sidebar, grouped into sections. Each module adds its section here as it ships, so the
// sidebar never links to something that doesn't exist yet. Items a staff member's role can't
// open are left out (the server enforces the same permissions on the routes themselves).
//
// item: { href, label, icon, perm, exact, children: [{ href, label, perm, exact, match }] }

const SECTIONS = [
  {
    label: '',
    items: [
      { href: '/admin', label: 'Home', icon: 'home', exact: true },
    ],
  },
  {
    label: 'Store',
    items: [
      { href: '/admin/orders', label: 'Orders', icon: 'orders', perm: 'orders.view' },
      {
        href: '/admin/products', label: 'Products', icon: 'products', perm: 'products.manage',
        children: [
          { href: '/admin/products', label: 'All products', exact: true, match: /^\/admin\/products\/(\d+|new)$/ },
          { href: '/admin/collections', label: 'Collections' },
          { href: '/admin/products/inventory', label: 'Inventory' },
        ],
      },
      { href: '/admin/customers', label: 'Customers', icon: 'customers', perm: 'customers.view' },
      {
        href: '/admin/content', label: 'Content', icon: 'content', perm: 'content.manage',
        children: [
          { href: '/admin/content/pages', label: 'Pages' },
          { href: '/admin/content/blog', label: 'Blog posts' },
          { href: '/admin/content/files', label: 'Files' },
          { href: '/admin/content/navigation', label: 'Navigation' },
        ],
      },
      { href: '/admin/analytics', label: 'Analytics', icon: 'analytics', perm: 'analytics.view' },
      { href: '/admin/discounts', label: 'Discounts', icon: 'discounts', perm: 'discounts.manage' },
    ],
  },
  {
    label: 'Sales channels',
    items: [
      {
        href: '/admin/themes', label: 'Online Store', icon: 'store', perm: 'themes.manage', storeLink: true,
        children: [
          { href: '/admin/themes', label: 'Themes', exact: true },
          { href: '/admin/settings/preferences', label: 'Preferences', perm: 'settings.manage' },
        ],
      },
    ],
  },
];

const SETTINGS_PERMS = ['settings.manage', 'staff.manage', 'audit.view'];

function navFor(can) {
  return SECTIONS.map((section) => ({
    label: section.label,
    items: section.items
      .filter((item) => !item.perm || can(item.perm))
      .map((item) => ({ ...item, children: item.children && item.children.filter((c) => !c.perm || can(c.perm)) })),
  })).filter((s) => s.items.length);
}

const showSettings = (can) => SETTINGS_PERMS.some(can);

module.exports = { SECTIONS, navFor, showSettings };
