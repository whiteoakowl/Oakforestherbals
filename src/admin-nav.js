'use strict';
// Admin sidebar, grouped into sections. Each module adds its section here as it ships, so the
// sidebar never links to something that doesn't exist yet. Items a staff member's role can't
// open are left out (the server enforces the same permissions on the routes themselves).
//
// item: { href, label, icon, perm, anyPerm, exact, children: [{ href, label, perm, exact, match }] }

const SECTIONS = [
  {
    label: '',
    items: [
      { href: '/admin', label: 'Home', icon: 'home', exact: true },
      { href: '/admin/assistant', label: 'Assistant', icon: 'spark', perm: 'assistant.use' },
    ],
  },
  {
    label: 'Store',
    items: [
      { href: '/admin/orders', label: 'Orders', icon: 'orders', perm: 'orders.view' },
      { href: '/admin/pos', label: 'Point of sale', icon: 'pos', perm: 'pos.use' },
      {
        href: '/admin/products', label: 'Products', icon: 'products', perm: 'products.manage',
        children: [
          { href: '/admin/products', label: 'All products', exact: true, match: /^\/admin\/products\/(\d+|new)$/ },
          { href: '/admin/collections', label: 'Collections' },
          { href: '/admin/products/inventory', label: 'Inventory' },
          { href: '/admin/reviews', label: 'Reviews' },
        ],
      },
      { href: '/admin/gift-cards', label: 'Gift cards', icon: 'discounts', perm: 'orders.manage' },
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
      {
        href: '/admin/costing', label: 'Costing', icon: 'cost', perm: 'costing.manage',
        children: [
          { href: '/admin/costing', label: 'Materials', exact: true, match: /^\/admin\/costing\/(materials|products)\// },
          { href: '/admin/analytics/profitability', label: 'Profitability' },
        ],
      },
      { href: '/admin/analytics', label: 'Analytics', icon: 'analytics', perm: 'analytics.view', exact: true },
      { href: '/admin/discounts', label: 'Discounts', icon: 'discounts', perm: 'discounts.manage' },
    ],
  },
  {
    label: 'Herbalist',
    items: [
      {
        href: '/admin/herbs', label: 'Herbal database', icon: 'herb', anyPerm: ['herbs.view', 'herbs.manage'],
        children: [
          { href: '/admin/herbs', label: 'Search', exact: true, match: /^\/admin\/herbs\/(?!browse|sources|terms|import|new)[\w-]+(\/edit)?$/ },
          { href: '/admin/herbs/browse', label: 'Browse' },
          { href: '/admin/herbs/sources', label: 'References' },
          { href: '/admin/herbs/terms', label: 'Categories', perm: 'herbs.manage' },
          { href: '/admin/herbs/import', label: 'Import / export', perm: 'herbs.manage' },
        ],
      },
    ],
  },
  {
    label: 'Apothecary',
    items: [
      {
        href: '/admin/inventory', label: 'Inventory', icon: 'box', perm: 'inventory.manage',
        children: [
          { href: '/admin/inventory', label: 'Stock', exact: true, match: /^\/admin\/inventory\/materials\// },
          { href: '/admin/inventory/purchase-orders', label: 'Purchase orders' },
          { href: '/admin/inventory/suppliers', label: 'Suppliers' },
          { href: '/admin/inventory/locations', label: 'Locations' },
        ],
      },
      { href: '/admin/formulas', label: 'Formulas', icon: 'flask', anyPerm: ['formulas.view', 'formulas.manage'] },
      {
        href: '/admin/production', label: 'Production', icon: 'batch', perm: 'production.manage',
        children: [
          { href: '/admin/production', label: 'Batches', exact: true, match: /^\/admin\/production\/(\d+|new)/ },
          { href: '/admin/production/trace', label: 'Batch tracing' },
        ],
      },
    ],
  },
  {
    label: 'Clinic',
    items: [
      {
        href: '/admin/clinic/patients', label: 'Patients', icon: 'patients', anyPerm: ['clinic.patients.view_assigned', 'clinic.patients.view_all'],
        children: [
          { href: '/admin/clinic/patients', label: 'All patients', exact: true, match: /^\/admin\/clinic\/patients\/(\d+|new)/ },
          { href: '/admin/clinic/inbox', label: 'Inbox' },
          { href: '/admin/clinic/forms', label: 'Forms', perm: 'clinic.records.manage' },
        ],
      },
      { href: '/admin/education', label: 'Education', icon: 'content', perm: 'education.manage' },
      {
        href: '/admin/schedule', label: 'Schedule', icon: 'calendar', anyPerm: ['scheduling.manage', 'scheduling.own'],
        children: [
          { href: '/admin/schedule', label: 'Calendar', exact: true, match: /^\/admin\/schedule\/appointments\// },
          { href: '/admin/schedule/types', label: 'Appointment types', perm: 'scheduling.manage' },
          { href: '/admin/schedule/hours', label: 'Hours and profile' },
        ],
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      { href: '/admin/finance', label: 'Financials', icon: 'analytics', perm: 'finance.view', exact: true },
      { href: '/admin/invoices', label: 'Invoices', icon: 'orders', perm: 'invoices.manage' },
      { href: '/admin/finance/expenses', label: 'Expenses', icon: 'cost', anyPerm: ['finance.view', 'expenses.manage'] },
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
      .filter((item) => (!item.perm || can(item.perm)) && (!item.anyPerm || item.anyPerm.some(can)))
      .map((item) => ({ ...item, children: item.children && item.children.filter((c) => !c.perm || can(c.perm)) })),
  })).filter((s) => s.items.length);
}

const showSettings = (can) => SETTINGS_PERMS.some(can);

module.exports = { SECTIONS, navFor, showSettings };
