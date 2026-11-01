import { AppError } from '../../shared/errors/errorHandler.js';
export const VG_CASH_DESK_ID = '9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';
export const VG_CASH_DESK_CODE = 'TOZON_PLAZA_2_CASH';
export function isVgDesk(desk) { return String(desk?.id ?? desk) === VG_CASH_DESK_ID || desk?.code === VG_CASH_DESK_CODE; }
export function accountingScope(filters = {}) {
  if (filters.accounting_scope && !['AB', 'VG'].includes(filters.accounting_scope)) throw new AppError('Выберите учёт А/Б или В/Г', 400);
  return filters.accounting_scope || 'AB';
}
export function dealProjectId(deal) { return Number(deal?.units?.floors?.sections?.buildings?.project_id); }
export function matchesAccountingScope(document, scope) {
  const vg = isVgDesk(document.cash_desk_id ?? document.cashDeskId) || dealProjectId(document.deals) === 4;
  return scope === 'VG' ? vg : !vg;
}
export function assertSameAccountingScope(from, to) {
  if (isVgDesk(from) !== isVgDesk(to)) throw new AppError('Касса В/Г ведётся отдельно. Перемещение и обмен между кассами А/Б и В/Г запрещены.', 400);
}
