// Central registry for CRM API modules that use the standard read/write matrix.
// New modules must register their API prefix and permission here before release.
// Unknown API routes remain denied for users with an explicit access matrix.
export const sectionRoutes = Object.freeze([
  { prefix: '/api/calls', permission: 'leads.view' },
  { prefix: '/api/sales-plans', permission: 'leads.view' },
  { prefix: '/api/tasks', permission: 'tasks.view' },
  { prefix: '/api/roles', permission: 'users.view' },
  { prefix: '/api/users', permission: 'users.view' },
  { prefix: '/api/costs', permission: 'finance.costs' },
  { prefix: '/api/notifications', permission: null, personal: true },
]);
export const matchSectionRoute = path => sectionRoutes.find(({ prefix }) => path === prefix || path.startsWith(prefix + '/'));
