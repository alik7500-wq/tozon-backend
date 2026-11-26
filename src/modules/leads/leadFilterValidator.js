import crypto from 'node:crypto';
import { CANONICAL_STAGE_CODES, LOST_REASON_CODES, buildLeadAccessScope } from './leadDomain.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export const ALLOWED_QUICK_FILTERS = Object.freeze([
  'ALL', 'MY', 'NEW', 'UNASSIGNED', 'AWAITING_RESPONSE', 'AWAITING_CONTACT',
  'NO_TASK', 'OVERDUE', 'UNREAD', 'REPEAT', 'CLOSED', 'IN_PROGRESS'
]);
export const ALLOWED_TASK_STATES = Object.freeze(['NO_TASK', 'PAUSED', 'HAS_OPEN', 'OVERDUE']);
export const ALLOWED_ARCHIVE_MODES = Object.freeze(['active', 'archived', 'all']);
export const ALLOWED_SOURCES = Object.freeze([
  'WALK_IN', 'PHONE', 'INSTAGRAM', 'FACEBOOK', 'TELEGRAM', 'WHATSAPP', 'REFERRAL', 'WEBSITE', 'OTHER', 'DIRECT'
]);

export const MAX_EXPORT_ROWS = Number(process.env.LEADS_EXPORT_MAX_ROWS || 50000);

const KNOWN_QUERY_KEYS = new Set([
  'projectId', 'managerId', 'source', 'accountId', 'stage', 'status',
  'createdFrom', 'createdTo', 'taskState', 'unread', 'archive', 'lostReason',
  'quickFilter', 'search', 'unassigned', 'groupBy', 'cursor', 'limit',
  'boardPerStageLimit'
]);

export function computeFilterHash(filters) {
  const canonical = JSON.stringify({
    project_id: filters.project_id || null,
    manager_id: filters.manager_id || null,
    source: filters.source || null,
    account_id: filters.account_id || null,
    stage: filters.stage || null,
    created_from: filters.created_from || null,
    created_to: filters.created_to || null,
    task_state: filters.task_state || null,
    unread: filters.unread ?? null,
    archive: filters.archive || 'active',
    lost_reason: filters.lost_reason || null,
    quick_filter: filters.quick_filter || null,
    search: filters.search || null
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const ISO_US_CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function encodeLeadCursor(lastRow, filterHash) {
  if (!lastRow || !lastRow.id) return null;
  const tsRaw = String(lastRow.created_at_iso_us || lastRow.created_at_ts || lastRow.created_at || '');
  if (!tsRaw) return null;
  const payload = {
    c: tsRaw,
    id: String(lastRow.id_str || lastRow.id),
    f: filterHash
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeAndVerifyLeadCursor(cursorToken, expectedFilterHash) {
  if (!cursorToken) return null;
  try {
    const raw = Buffer.from(String(cursorToken), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.c !== 'string' || !/^\d+$/.test(String(parsed.id || '')) || !parsed.f) {
      throw new Error('Malformed cursor');
    }
    if (parsed.f !== expectedFilterHash) {
      throw new AppError('Курсор не соответствует текущему набору фильтров. Сбросьте пагинацию.', 400);
    }
    // Preserve exact microsecond timestamp string (do NOT truncate via new Date().toISOString())
    const parsedMs = Date.parse(parsed.c);
    if (!ISO_US_CURSOR_RE.test(parsed.c) || !Number.isFinite(parsedMs) || parsedMs < 0 || parsedMs > 4102444800000) {
      throw new Error('Invalid cursor timestamp');
    }
    return { cursor_created_at: parsed.c, cursor_id: String(parsed.id) };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Некорректный курсор пагинации', 400);
  }
}

export function validateAndNormalizeLeadQuery(query = {}, user = {}) {
  for (const key of Object.keys(query)) {
    if (!KNOWN_QUERY_KEYS.has(key)) {
      throw new AppError(`Неподдерживаемый параметр фильтрации: ${key}`, 400);
    }
  }

  const scope = buildLeadAccessScope(user, {
    projectId: query.projectId,
    managerId: query.managerId
  });

  const stageRaw = query.stage || query.status;
  let stage = null;
  if (stageRaw && String(stageRaw).toUpperCase() !== 'ALL') {
    const upper = String(stageRaw).toUpperCase();
    if (upper === 'UNASSIGNED') {
      // legacy alias
    } else if (!CANONICAL_STAGE_CODES.includes(upper)) {
      throw new AppError(`Неизвестный этап воронки: ${stageRaw}`, 400);
    } else {
      stage = upper;
    }
  }

  let quickFilter = null;
  if (query.quickFilter) {
    const upper = String(query.quickFilter).toUpperCase();
    if (!ALLOWED_QUICK_FILTERS.includes(upper)) {
      throw new AppError(`Неизвестный быстрый фильтр: ${query.quickFilter}`, 400);
    }
    quickFilter = upper === 'AWAITING_CONTACT' ? 'AWAITING_RESPONSE' : upper;
  } else if (String(stageRaw || '').toUpperCase() === 'UNASSIGNED' || query.unassigned === 'true') {
    quickFilter = 'UNASSIGNED';
  }

  let taskState = null;
  if (query.taskState) {
    const upper = String(query.taskState).toUpperCase();
    if (!ALLOWED_TASK_STATES.includes(upper)) {
      throw new AppError(`Неизвестное состояние задачи: ${query.taskState}`, 400);
    }
    taskState = upper;
  }

  const archive = query.archive ? String(query.archive).toLowerCase() : 'active';
  if (!ALLOWED_ARCHIVE_MODES.includes(archive)) {
    throw new AppError(`Недопустимое значение archive: ${query.archive}`, 400);
  }

  let lostReason = null;
  if (query.lostReason) {
    const upper = String(query.lostReason).toUpperCase();
    if (!LOST_REASON_CODES.includes(upper)) {
      throw new AppError(`Неизвестная причина отказа: ${query.lostReason}`, 400);
    }
    lostReason = upper;
  }

  let source = null;
  if (query.source) {
    const upper = String(query.source).toUpperCase();
    if (!ALLOWED_SOURCES.includes(upper)) {
      throw new AppError(`Неизвестный источник: ${query.source}`, 400);
    }
    source = upper;
  }

  let unread = null;
  if (query.unread !== undefined && query.unread !== '') {
    if (!['true', 'false'].includes(String(query.unread))) {
      throw new AppError(`Недопустимое значение unread: ${query.unread}`, 400);
    }
    unread = String(query.unread);
  }

  for (const [label, val] of [['createdFrom', query.createdFrom], ['createdTo', query.createdTo]]) {
    if (val) {
      const d = new Date(val);
      if (!Number.isFinite(d.getTime())) {
        throw new AppError(`Некорректная дата ${label}: ${val}`, 400);
      }
    }
  }

  let limit = 50;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 0 || n > 500) {
      throw new AppError(`Недопустимый limit: ${query.limit}`, 400);
    }
    limit = n;
  }

  let boardPerStageLimit = 0;
  if (query.boardPerStageLimit !== undefined && query.boardPerStageLimit !== '') {
    const b = Number(query.boardPerStageLimit);
    if (!Number.isInteger(b) || b < 0 || b > 100) {
      throw new AppError(`Недопустимый boardPerStageLimit: ${query.boardPerStageLimit}`, 400);
    }
    boardPerStageLimit = b;
  }

  let projectId = null;
  if (query.projectId && String(query.projectId) !== 'ALL') {
    if (!/^\d+$/.test(String(query.projectId))) {
      throw new AppError(`Некорректный projectId: ${query.projectId}`, 400);
    }
    projectId = String(query.projectId);
  }

  let managerId = null;
  if (scope.restrictedToSelf) {
    managerId = user?.id ? String(user.id) : null;
  } else if (query.managerId && String(query.managerId) !== 'ALL') {
    if (!/^\d+$/.test(String(query.managerId))) {
      throw new AppError(`Некорректный managerId: ${query.managerId}`, 400);
    }
    managerId = String(query.managerId);
  }

  const dbFilters = {
    project_id: projectId,
    manager_id: managerId,
    source,
    account_id: query.accountId ? String(query.accountId) : null,
    stage,
    created_from: query.createdFrom || null,
    created_to: query.createdTo || null,
    task_state: taskState,
    unread,
    archive,
    lost_reason: lostReason,
    quick_filter: quickFilter,
    search: query.search ? String(query.search).trim() : null,
    limit,
    ...(boardPerStageLimit > 0 ? { board_per_stage_limit: boardPerStageLimit } : {})
  };

  const filterHash = computeFilterHash(dbFilters);
  const decodedCursor = query.cursor ? decodeAndVerifyLeadCursor(query.cursor, filterHash) : null;
  if (decodedCursor) {
    dbFilters.cursor_created_at = decodedCursor.cursor_created_at;
    dbFilters.cursor_id = decodedCursor.cursor_id;
  }

  // Server-authoritative project scope (R04.2):
  // - Never infer global DIRECTOR rights from missing allowed_project_ids
  // - Never grant all-projects access on empty/unknown scope
  // - Only explicit all_projects_access === true (or ADMIN with wildcard '*' and not explicitly disabled) grants global scope
  if (user?.project_scope_error) {
    throw new AppError('Не удалось загрузить проектные права доступа пользователя', 503);
  }
  const isExplicitAdminWildcard =
    scope.role === 'ADMIN' &&
    Array.isArray(user?.permissions) &&
    user.permissions.includes('*') &&
    user?.all_projects_access !== false;
  const hasExplicitProjectList = Array.isArray(user?.allowed_project_ids);
  const hasAllProjects = user?.all_projects_access === true || isExplicitAdminWildcard;

  const dbScope = {
    user_id: user?.id ? String(user.id) : null,
    role: scope.role,
    restricted_to_self: scope.restrictedToSelf,
    has_all_projects: hasAllProjects,
    allowed_project_ids: hasExplicitProjectList ? user.allowed_project_ids.map(String) : []
  };

  return {
    dbFilters,
    dbScope,
    filterHash,
    scope
  };
}
