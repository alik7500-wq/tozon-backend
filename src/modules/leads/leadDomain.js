/**
 * Canonical CRM Sales Domain Rules (F-01, F-02, F-03, F-12, Section 13)
 * Pure, deterministic helpers shared across routes, services, and tests.
 */

export const CANONICAL_STAGES = Object.freeze([
  { code: 'NEW', label: 'Новый лид', order: 1, legacyStatus: 'NEW' },
  { code: 'IN_PROGRESS', label: 'В работе', order: 2, legacyStatus: 'IN_PROGRESS' },
  { code: 'NEGOTIATION', label: 'Переговоры', order: 3, legacyStatus: 'NEGOTIATION' },
  { code: 'MEETING_SCHEDULED', label: 'Встреча назначена', order: 4, legacyStatus: 'NEGOTIATION' },
  { code: 'SHOWING_DONE', label: 'Показ проведён', order: 5, legacyStatus: 'NEGOTIATION' },
  { code: 'RESERVED', label: 'Бронь', order: 6, legacyStatus: 'NEGOTIATION' },
  { code: 'CONTRACT_PREP', label: 'Подготовка договора', order: 7, legacyStatus: 'NEGOTIATION' },
  { code: 'SIGNED', label: 'Договор подписан', order: 8, legacyStatus: 'WON', readOnly: true },
  { code: 'LOST', label: 'Отказ / закрыто', order: 9, legacyStatus: 'LOST' }
]);

export const CANONICAL_STAGE_CODES = Object.freeze(CANONICAL_STAGES.map((s) => s.code));
export const STAGE_ORDER_MAP = Object.freeze(Object.fromEntries(CANONICAL_STAGES.map((s) => [s.code, s.order])));

export const LOST_REASONS = Object.freeze([
  { code: 'PRICE', label: 'Не устроила цена' },
  { code: 'LOCATION', label: 'Не устроило расположение' },
  { code: 'PAYMENT_TERMS', label: 'Не устроили условия рассрочки/оплаты' },
  { code: 'NO_RESPONSE', label: 'Не выходит на связь' },
  { code: 'CHOSE_COMPETITOR', label: 'Выбрал конкурента' },
  { code: 'NOT_READY', label: 'Не готов к покупке сейчас' },
  { code: 'OTHER', label: 'Другое (указать комментарий)' }
]);

export const LOST_REASON_CODES = Object.freeze(LOST_REASONS.map((r) => r.code));

export const COMMUNICATION_EVENT_TYPES = Object.freeze({
  ATTEMPT: 'ATTEMPT',
  NO_ANSWER: 'NO_ANSWER',
  BUSY: 'BUSY',
  CONNECTED_CALL: 'CONNECTED_CALL',
  OUTBOUND_MESSAGE: 'OUTBOUND_MESSAGE',
  INBOUND_MESSAGE: 'INBOUND_MESSAGE',
  MEETING_SCHEDULED: 'MEETING_SCHEDULED',
  MEETING_DONE: 'MEETING_DONE',
  MEETING_RESCHEDULED: 'MEETING_RESCHEDULED',
  MEETING_NO_SHOW: 'MEETING_NO_SHOW',
  SHOWING_SCHEDULED: 'SHOWING_SCHEDULED',
  SHOWING_DONE: 'SHOWING_DONE',
  SHOWING_RESCHEDULED: 'SHOWING_RESCHEDULED',
  SHOWING_NO_SHOW: 'SHOWING_NO_SHOW',
  AUTO_NOTIFICATION: 'AUTO_NOTIFICATION'
});

/**
 * Resolves the canonical stage of a lead.
 * Never promotes legacy status='WON' to 'SIGNED' without an actual SIGNED deal (F-02, F-15).
 */
export function resolveCanonicalStage(lead, deals = []) {
  const dealList = Array.isArray(deals) ? deals : [];
  const hasSignedDeal = dealList.some((d) => d.status === 'SIGNED');
  if (hasSignedDeal) {
    return { stage: 'SIGNED', legacy_unverified_won: false };
  }

  const hasReservedDeal = dealList.some((d) => d.status === 'RESERVED');
  if (hasReservedDeal) {
    return { stage: 'RESERVED', legacy_unverified_won: false };
  }

  const hasDraftDeal = dealList.some((d) => d.status === 'DRAFT');
  if (hasDraftDeal) {
    return { stage: 'CONTRACT_PREP', legacy_unverified_won: false };
  }

  const isLegacyWon = lead?.status === 'WON';
  if (isLegacyWon) {
    return { stage: 'CONTRACT_PREP', legacy_unverified_won: true };
  }

  if (lead?.stage && CANONICAL_STAGE_CODES.includes(lead.stage) && lead.stage !== 'SIGNED') {
    return { stage: lead.stage, legacy_unverified_won: false };
  }

  if (lead?.status === 'LOST') return { stage: 'LOST', legacy_unverified_won: false };
  if (lead?.status === 'NEGOTIATION') return { stage: 'NEGOTIATION', legacy_unverified_won: false };
  if (lead?.status === 'IN_PROGRESS') return { stage: 'IN_PROGRESS', legacy_unverified_won: false };
  return { stage: 'NEW', legacy_unverified_won: false };
}

export function mapStageToLegacyStatus(stage) {
  const found = CANONICAL_STAGES.find((s) => s.code === stage);
  return found ? found.legacyStatus : 'NEW';
}

/**
 * Validates stage transition rules (F-02).
 * Returns { ok: true } or { ok: false, code, message }.
 */
export function validateStageTransition({
  currentStage,
  targetStage,
  reasonCode,
  reasonComment,
  meetingAt,
  showingProjectId,
  showingAt,
  showingOutcome
} = {}) {
  if (!CANONICAL_STAGE_CODES.includes(targetStage)) {
    return { ok: false, code: 'INVALID_STAGE', message: `Недопустимый этап воронки: ${targetStage}` };
  }

  if (currentStage === 'SIGNED') {
    return {
      ok: false,
      code: 'SIGNED_READ_ONLY',
      message: 'Договор подписан: статус нельзя изменить перетаскиванием. Используйте регламент расторжения.'
    };
  }

  if (targetStage === 'SIGNED') {
    return {
      ok: false,
      code: 'SIGNED_REQUIRES_DEAL',
      message: 'Этап «Договор подписан» устанавливается только при подтверждении подписанной сделки.'
    };
  }

  if (targetStage === 'LOST') {
    if (!reasonCode || !LOST_REASON_CODES.includes(reasonCode)) {
      return {
        ok: false,
        code: 'LOST_REASON_REQUIRED',
        message: 'При переводе в отказ необходимо указать причину закрытия.'
      };
    }
    if (reasonCode === 'OTHER' && (!reasonComment || !String(reasonComment).trim())) {
      return {
        ok: false,
        code: 'LOST_COMMENT_REQUIRED',
        message: 'При выборе причины «Другое» обязателен текстовый комментарий.'
      };
    }
  }

  if (targetStage === 'MEETING_SCHEDULED' && !meetingAt) {
    return {
      ok: false,
      code: 'MEETING_DETAILS_REQUIRED',
      message: 'Для назначения встречи укажите точные дату и время.'
    };
  }

  if (targetStage === 'SHOWING_DONE' && (!showingAt || !showingOutcome || !showingProjectId)) {
    return {
      ok: false,
      code: 'SHOWING_DETAILS_REQUIRED',
      message: 'Для фиксации проведённого показа укажите объект/проект, время и результат.'
    };
  }

  const currentOrder = STAGE_ORDER_MAP[currentStage] || 1;
  const targetOrder = STAGE_ORDER_MAP[targetStage] || 1;
  if (
    currentStage !== 'LOST' &&
    targetStage !== 'LOST' &&
    targetOrder < currentOrder &&
    (!reasonComment || !String(reasonComment).trim())
  ) {
    return {
      ok: false,
      code: 'BACKWARD_REASON_REQUIRED',
      message: 'Возврат на предыдущий этап требует указания причины.'
    };
  }

  return { ok: true };
}

/**
 * Enforces server-side RBAC scope (Section 13).
 * Query parameter managerId=ALL never expands privileges for SALES_MANAGER.
 */
export function buildLeadAccessScope(user, requestedFilters = {}) {
  const role = String(user?.role || '').toUpperCase();
  const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(role);
  const restrictedToSelf = !isSupervisor;

  const effectiveFilters = { ...requestedFilters };
  if (restrictedToSelf) {
    effectiveFilters.responsibleUserId = user?.id ? String(user.id) : '__FORBIDDEN__';
  } else if (requestedFilters.managerId && requestedFilters.managerId !== 'ALL') {
    effectiveFilters.responsibleUserId = String(requestedFilters.managerId);
  }

  return {
    role,
    restrictedToSelf,
    effectiveFilters
  };
}

/**
 * Classifies a communication event for SLA & Contact metrics (F-12, A16-A18).
 */
export function classifyCommunicationEffect(eventType) {
  switch (eventType) {
    case COMMUNICATION_EVENT_TYPES.CONNECTED_CALL:
      return { countsAsHumanAction: true, countsAsFirstResponse: true, countsAsConfirmedContact: true };
    case COMMUNICATION_EVENT_TYPES.OUTBOUND_MESSAGE:
      return { countsAsHumanAction: true, countsAsFirstResponse: true, countsAsConfirmedContact: false };
    case COMMUNICATION_EVENT_TYPES.INBOUND_MESSAGE:
      return { countsAsHumanAction: false, countsAsFirstResponse: false, countsAsConfirmedContact: true };
    case COMMUNICATION_EVENT_TYPES.ATTEMPT:
    case COMMUNICATION_EVENT_TYPES.NO_ANSWER:
    case COMMUNICATION_EVENT_TYPES.BUSY:
      return { countsAsHumanAction: true, countsAsFirstResponse: false, countsAsConfirmedContact: false };
    case COMMUNICATION_EVENT_TYPES.MEETING_DONE:
    case COMMUNICATION_EVENT_TYPES.SHOWING_DONE:
      return { countsAsHumanAction: true, countsAsFirstResponse: true, countsAsConfirmedContact: true };
    case COMMUNICATION_EVENT_TYPES.AUTO_NOTIFICATION:
    default:
      return { countsAsHumanAction: false, countsAsFirstResponse: false, countsAsConfirmedContact: false };
  }
}
