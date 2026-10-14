import { AppError } from '../shared/errors/errorHandler.js';
import { getServiceDB } from '../db/connection.js';

export const ACCESS_PROFILE = 'access.v2';
const pairs = {
  'inventory.view': 'inventory.manage', 'leads.view': 'leads.manage',
  'deals.view': 'deals.manage', 'contracts.view': 'contracts.manage',
  'tasks.view': 'tasks.manage', 'automation.view': 'automation.manage',
  'users.view': 'users.manage', 'settings.view': 'settings.manage'
};
export const readKey = key => Object.keys(pairs).find(k => pairs[k] === key) || key;
export const writeKey = key => pairs[key] || `${key}.write`;
export const isMatrixUser = user => user?.permissions?.includes(ACCESS_PROFILE) && user.role !== 'ADMIN';
export const hasSection = (user, key, write = false) => {
  if (user?.role === 'ADMIN') return true;
  const permissions = user?.permissions || [];
  if (isMatrixUser(user)) return permissions.includes(key) && (!write || permissions.includes(writeKey(key)));
  return permissions.includes('*') || permissions.includes(key);
};
const financeReads = ['finance.view','finance.payments','finance.expenses','finance.debtors','finance.cashflow'];
const constructionReads = ['construction.stock','construction.advance','construction.settlements','construction.settings'];
const hasAny = (user, keys, write = false) => keys.some(key => hasSection(user, key, write));
const stockTypes = ['OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF'];
const constructionKey = kind => stockTypes.includes(kind) ? 'construction.stock' : String(kind).includes('ADVANCE') ? 'construction.advance' : 'construction.settlements';

// Explicit per-section matrix. Older user profiles continue through the existing guards.
export const authorizeSectionRequest = async req => {
  const user = req.user;
  if (!isMatrixUser(user)) return;
  const path = String(req.originalUrl || '').split('?')[0].replace(/\/$/, '');
  const read = ['GET','HEAD'].includes(req.method);
  let key;
  let allowed;
  if (path.startsWith('/api/auth/')) return;
  if (path.startsWith('/api/notifications')) return; // personal notifications, existing ownership checks apply
  if (path.startsWith('/api/construction')) {
    if (read) allowed = hasAny(user, constructionReads);
    else if (/\/masters\/|\/settings$/.test(path)) key = 'construction.settings';
    else if (/\/documents(?:\/|$)/.test(path)) {
      let kind = req.body?.kind;
      const match = path.match(/\/documents\/([0-9a-f-]{36})(?:\/|$)/i);
      if (match) {
        const { data, error } = await getServiceDB().from('construction_documents').select('kind').eq('id', match[1]).maybeSingle();
        if (error || !data) throw new AppError('Документ недоступен', 404);
        kind = data.kind;
      }
      if (kind) key = constructionKey(kind);
    }
  } else if (path.startsWith('/api/finance')) {
    if (/\/income(?:\/|$)/.test(path)) key = 'finance.payments';
    else if (/\/expenses(?:\/|$)/.test(path)) key = 'finance.expenses';
    else if (/\/cashflow(?:\/|$)|\/transfers$|\/convert$/.test(path)) key = 'finance.cashflow';
    else if (/\/debtors(?:\/|$)/.test(path)) key = 'finance.debtors';
    else key = 'finance.view';
  } else if (/^\/api\/deals\/[^/]+\/payments(?:\/|$)/.test(path)) key = 'finance.payments';
  else if (path.startsWith('/api/deals')) {
    key = /\/sign$/.test(path) ? 'contracts.view' : 'deals.view';
    if (read) allowed = hasSection(user,'deals.view') || hasAny(user, financeReads);
  } else if (path.startsWith('/api/leads')) key = 'leads.view';
  else if (path.startsWith('/api/tasks')) key = 'tasks.view';
  else if (path.startsWith('/api/users')) {
    key = 'users.view';
    if (read && path === '/api/users' && String(req.query?.lookup) === '1') allowed = hasAny(user, ['users.view','leads.view','tasks.view','deals.view','settings.view',...financeReads,...constructionReads]);
  }
  else if (path.startsWith('/api/document-settings')) {
    key = /\/render\//.test(path) ? 'contracts.view' : 'settings.view';
    if (/\/render\//.test(path)) allowed = hasSection(user, 'contracts.view'); // document rendering is read-only
  } else if (path.startsWith('/api/documents')) key = 'leads.view';
  else if (path.startsWith('/api/contracts')) key = 'contracts.view';
  else if (path.startsWith('/api/sms') || path.startsWith('/api/automation')) {
    key = 'automation.view';
    if (req.method === 'POST' && /\/preview$|\/template-availability$|\/events\/[^/]+\/preview$/.test(path)) allowed = hasSection(user,key);
  } else if (path.startsWith('/api/reports')) key = /\/analytics-[123]$/.test(path) ? 'analytics.view' : 'analytics.reports';
  else if (path.startsWith('/api/dashboard')) key = 'analytics.view';
  else if (path.startsWith('/api/dictionaries')) {
    key = 'settings.view';
    if (read) allowed = hasAny(user, ['settings.view','inventory.view','leads.view','deals.view',...financeReads,...constructionReads]);
  } else if (path.startsWith('/api/search')) {
    // Search aggregates several sections. Require all of them to avoid bypassing read restrictions.
    allowed = read && ['leads.view','deals.view','inventory.view'].every(k => hasSection(user,k));
  } else if (/^\/api\/(?:projects|inventory|apartments|visual-maps|visual3d|tour360|project-media|3d-scenes|3d-scene-entities|360-tours|360-panoramas|360-hotspots|upload)(?:\/|$)/.test(path)) {
    key = 'inventory.view';
    if (read && path.startsWith('/api/projects')) allowed = hasSection(user,key) || hasAny(user,[...financeReads,'analytics.view','analytics.reports']);
  }
  if (allowed === undefined) allowed = key ? hasSection(user,key,!read) : false;
  if (!allowed) throw new AppError(read ? 'Нет права чтения этого раздела' : 'Нет права добавления или редактирования в этом разделе', 403);
  req.sectionAccessGranted = true;
};
