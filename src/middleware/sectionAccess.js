import { AppError } from '../shared/errors/errorHandler.js';
import { getServiceDB } from '../db/connection.js';
import { matchSectionRoute } from './sectionRegistry.js';

export const ACCESS_PROFILE = 'access.v2';
const pairs = {
  'inventory.view': 'inventory.manage', 'leads.view': 'leads.manage',
  'deals.view': 'deals.manage', 'contracts.view': 'contracts.manage',
  'tasks.view': 'tasks.manage', 'automation.view': 'automation.manage',
  'users.view': 'users.manage', 'settings.view': 'settings.manage'
};
export const readKey = key => Object.keys(pairs).find(k => pairs[k] === key) || key;
export const writeKey = key => pairs[key] || `${key}.write`;
export const isMatrixUser = user => user?.permissions?.includes(ACCESS_PROFILE);
export const hasSection = (user, key, write = false) => {
  const permissions = user?.permissions || [];
  if (user?.role === 'ADMIN' && !isMatrixUser(user)) return true;
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
  // Optional granular permissions: preserve access.v2 accounts until explicit migration.
  // These are actual finance router endpoints, not frontend URLs.
  if (user.permissions?.includes('access.granular.v1')) {
    const feature = path === '/api/finance/income/customer-book.xlsx'
      ? 'finance.customer_pko_book'
      : path === '/api/finance/calendar'
        ? 'finance.payment_calendar'
        : path === '/api/finance/plan-fact'
          ? 'finance.plan_fact'
          : (path === '/api/finance/transfers' || path === '/api/finance/convert')
            ? 'finance.cash_transfers'
            : null;
    const extra = path.startsWith('/api/360-tours/') || path === '/api/360-tours' || (path === '/api/360-panoramas' || path.startsWith('/api/360-panoramas/')) || (path === '/api/360-hotspots' || path.startsWith('/api/360-hotspots/')) || path.startsWith('/api/tour360/') ? 'inventory.tours_360' : path.startsWith('/api/sms/') || path === '/api/sms' ? 'automation.sms_notifications' : null;
    if ((feature || extra) && !hasSection(user, feature || extra, !read)) {
      throw new AppError('Нет доступа к отдельной функции', 403);
    }
  }
  if (path.startsWith('/api/auth/')) return;
  if (path.startsWith('/api/notifications')) return; // personal notifications, existing ownership checks apply
  if (path.startsWith('/api/costs')) {
    key = 'finance.costs';
  } else if (path.startsWith('/api/construction')) {
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
    if (path === '/api/finance/access' && read) allowed = hasAny(user, financeReads);
    if (/\/income(?:\/|$)/.test(path)) key = 'finance.payments';
    else if (/\/expenses(?:\/|$)/.test(path)) {
      key = 'finance.expenses';
      if (!read && req.body?.auto_convert && !hasSection(user,'finance.cashflow',true)) throw new AppError('Автоконвертация требует права изменения ДДС',403);
    }
    else if (/\/cashflow(?:\/|$)|\/transfers$|\/convert$/.test(path)) key = 'finance.cashflow';
    else if (/\/debtors(?:\/|$)/.test(path)) key = 'finance.debtors';
    else key = 'finance.view';
  } else if (/^\/api\/deals\/[^/]+\/payments(?:\/|$)/.test(path)) key = 'finance.payments';
  else if (path.startsWith('/api/deals')) {
    key = /\/sign$/.test(path) ? 'contracts.view' : 'deals.view';
    if (user.role === 'WAREHOUSE_MANAGER') allowed = false;
    else if (read) allowed = hasSection(user,'deals.view') || hasAny(user, ['finance.view','finance.payments','finance.debtors','finance.cashflow']);
  } else if (path.startsWith('/api/leads')) {
    key = 'leads.view';
    if (user.role === 'WAREHOUSE_MANAGER') allowed = false;
    if (user.role === 'FINANCE_MANAGER' && /\/distribution|\/winback/.test(path)) allowed = false;
  }
  else if (path.startsWith('/api/sales-plans')) {
    key = 'leads.view';
    if (user.role === 'FINANCE_MANAGER') allowed = false;
  }
  else if (path.startsWith('/api/tasks')) key = 'tasks.view';
  else if (path.startsWith('/api/roles')) key = 'users.view';
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
  } else if (path.startsWith('/api/reports')) {
    if (/\/sales-|\/apartment-demand/.test(path)) {
      if (user.role === 'FINANCE_MANAGER') allowed = false;
      else if (read) allowed = hasAny(user, ['analytics.view', 'analytics.reports', 'leads.view', 'deals.view']);
    } else {
      key = /\/analytics-[123]$/.test(path) ? 'analytics.view' : 'analytics.reports';
    }
  } else if (path.startsWith('/api/dashboard')) {
    key = 'analytics.view';
    if (read) allowed = hasAny(user, ['analytics.view', 'leads.view', 'deals.view', 'inventory.view']);
  }
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
  if (allowed === undefined && !key) key = matchSectionRoute(path)?.permission;
  if (allowed === undefined) allowed = key ? hasSection(user,key,!read) : false;
  if (!allowed) throw new AppError(read ? 'Нет права чтения этого раздела' : 'Нет права добавления или редактирования в этом разделе', 403);
  req.sectionAccessGranted = true;
};

