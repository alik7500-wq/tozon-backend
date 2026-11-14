import ExcelJS from 'exceljs';
import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { ApartmentSalesReportService } from '../reports/apartmentSalesReport.service.js';
import {
  AUDIT_ACTION_COMMISSION,
  COMMISSION_STATUS_LABELS,
  marketingAttributionService,
} from '../reports/marketingAttribution.service.js';

const READ_ROLES = new Set(['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'SALES_MANAGER']);
const EXPORT_ROLES = new Set(['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER']);
const RKO_ROLES = new Set(['ADMIN', 'FINANCE_MANAGER']);

function getSecureDB() {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
}

function normalizeRole(user) {
  return String(user?.role || '').trim().toUpperCase();
}

function toMinor(usd) {
  const n = Number(usd || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function minorToUsd(minor) {
  return Number((Math.round(Number(minor || 0)) / 100).toFixed(2));
}

function safeCell(value) {
  const str = String(value ?? '');
  return /^[=+@-]/.test(str) ? `'${str}` : str;
}

function aggregateRows(rows) {
  let contractPriceMinor = 0;
  let totalSettledMinor = 0;
  let calculatedCommissionMinor = 0;
  let approvedCommissionMinor = 0;
  let paidCommissionMinor = 0;
  let remainingCommissionMinor = 0;
  let additionalAccrualMinor = 0;
  let overpaidCommissionMinor = 0;
  let unlinkedPayoutsCount = 0;
  let reconciliationRequiredCount = 0;
  const rateBreakdown = { '0': 0, '2': 0, '3': 0, '4': 0 };

  for (const row of rows) {
    contractPriceMinor += row.contractPriceMinor;
    totalSettledMinor += row.totalSettledMinor;
    calculatedCommissionMinor += row.calculatedCommissionMinor;
    approvedCommissionMinor += row.approvedCommissionMinor;
    paidCommissionMinor += row.paidCommissionMinor;
    remainingCommissionMinor += row.remainingCommissionMinor;
    additionalAccrualMinor += row.additionalAccrualMinor;
    overpaidCommissionMinor += row.overpaidCommissionMinor;
    if (row.paidCommissionMinor > 0 && (!row.rkoLinks || row.rkoLinks.length === 0)) {
      unlinkedPayoutsCount += 1;
    }
    if (row.reconciliationRequired || row.commissionStatus === 'RECONCILIATION_REQUIRED') {
      reconciliationRequiredCount += 1;
    }
    const rateKey = String(Math.round(Number(row.commissionRatePercent || 0)));
    if (Object.prototype.hasOwnProperty.call(rateBreakdown, rateKey)) {
      rateBreakdown[rateKey] += 1;
    }
  }

  return {
    dealsCount: rows.length,
    contractPriceMinor,
    contractPriceUsd: minorToUsd(contractPriceMinor),
    totalSettledMinor,
    totalSettledUsd: minorToUsd(totalSettledMinor),
    avgPaymentPercent: contractPriceMinor > 0
      ? Number(((totalSettledMinor / contractPriceMinor) * 100).toFixed(2))
      : 0,
    calculatedCommissionMinor,
    calculatedCommissionUsd: minorToUsd(calculatedCommissionMinor),
    approvedCommissionMinor,
    approvedCommissionUsd: minorToUsd(approvedCommissionMinor),
    paidCommissionMinor,
    paidCommissionUsd: minorToUsd(paidCommissionMinor),
    remainingCommissionMinor,
    remainingCommissionUsd: minorToUsd(remainingCommissionMinor),
    additionalAccrualMinor,
    additionalAccrualUsd: minorToUsd(additionalAccrualMinor),
    overpaidCommissionMinor,
    overpaidCommissionUsd: minorToUsd(overpaidCommissionMinor),
    unlinkedPayoutsCount,
    reconciliationRequiredCount,
    rateBreakdown,
  };
}

function buildPartnerSummary(rows) {
  const byPartner = new Map();

  for (const row of rows) {
    const key = row.marketingPartnerId ? String(row.marketingPartnerId) : `NAME::${row.marketingPartnerName || 'Не указан'}`;
    if (!byPartner.has(key)) {
      byPartner.set(key, {
        partnerId: row.marketingPartnerId,
        partnerName: row.marketingPartnerName || 'Партнёр не указан',
        rows: [],
      });
    }
    byPartner.get(key).rows.push(row);
  }

  return Array.from(byPartner.values())
    .map((group) => {
      const agg = aggregateRows(group.rows);
      return {
        partnerId: group.partnerId,
        partnerName: group.partnerName,
        ...agg,
      };
    })
    .sort((a, b) => b.calculatedCommissionMinor - a.calculatedCommissionMinor || b.dealsCount - a.dealsCount);
}

export class MarketingCommissionsService {
  static async loadRkoLinksByDealId(dealIds, dbOverride = null) {
    const linksByDealId = new Map();
    if (!Array.isArray(dealIds) || dealIds.length === 0) return linksByDealId;

    const db = dbOverride || getSecureDB();
    try {
      const { data: logs, error } = await db
        .from('deal_audit_logs')
        .select('id, deal_id, action, changes_json, created_at')
        .in('deal_id', dealIds)
        .eq('action', AUDIT_ACTION_COMMISSION)
        .order('created_at', { ascending: true });

      if (error || !Array.isArray(logs)) return linksByDealId;

      for (const log of logs) {
        const payload = typeof log.changes_json === 'string'
          ? (() => { try { return JSON.parse(log.changes_json); } catch { return {}; } })()
          : (log.changes_json || {});
        const dId = Number(log.deal_id);

        if (payload.action_type === 'RKO_VOIDED_RECONCILIATION_REQUIRED') {
          const voidedRkoId = payload.rko_expense_id ? Number(payload.rko_expense_id) : null;
          if (voidedRkoId && linksByDealId.has(dId)) {
            linksByDealId.set(
              dId,
              linksByDealId.get(dId).map((item) =>
                item.rkoExpenseId === voidedRkoId
                  ? { ...item, reconciliationStatus: 'RECONCILIATION_REQUIRED' }
                  : item
              )
            );
          }
          continue;
        }

        if (payload.action_type === 'CONFIRM_PAYOUT_REFUND') {
          const refundedRkoId = payload.rko_expense_id ? Number(payload.rko_expense_id) : null;
          const opStatus = payload.operation_reconciliation_status || 'REFUND_CONFIRMED';
          if (refundedRkoId && linksByDealId.has(dId)) {
            linksByDealId.set(
              dId,
              linksByDealId.get(dId).map((item) =>
                item.rkoExpenseId === refundedRkoId
                  ? { ...item, reconciliationStatus: opStatus, refundDocumentRef: payload.refund_document_ref || null }
                  : item
              )
            );
          }
          continue;
        }

        if (payload.action_type === 'RECONCILE_PAYOUT_RKO') {
          const oldRkoId = payload.old_rko_expense_id ? Number(payload.old_rko_expense_id) : null;
          const newRkoId = payload.new_rko_expense_id ? Number(payload.new_rko_expense_id) : null;
          if (oldRkoId && newRkoId && linksByDealId.has(dId)) {
            linksByDealId.set(
              dId,
              linksByDealId.get(dId).map((item) =>
                item.rkoExpenseId === oldRkoId
                  ? {
                      ...item,
                      rkoExpenseId: newRkoId,
                      rkoReference: payload.new_rko_reference || `РКО-${newRkoId}`,
                      reconciliationStatus: 'RECONCILED_NEW_RKO',
                    }
                  : item
              )
            );
          }
          continue;
        }

        if (payload.action_type === 'RKO_VOIDED_REVERSAL') {
          const voidedRkoId = payload.rko_expense_id ? Number(payload.rko_expense_id) : null;
          if (voidedRkoId && linksByDealId.has(dId)) {
            linksByDealId.set(
              dId,
              linksByDealId.get(dId).filter((item) => item.rkoExpenseId !== voidedRkoId)
            );
          }
          continue;
        }

        if (payload.action_type !== 'RECORD_PAYOUT') continue;
        if (!payload.rko_expense_id && !payload.rko_reference) continue;

        if (!linksByDealId.has(dId)) linksByDealId.set(dId, []);
        linksByDealId.get(dId).push({
          logId: log.id,
          rkoExpenseId: payload.rko_expense_id ? Number(payload.rko_expense_id) : null,
          rkoReference: payload.rko_reference || (payload.rko_expense_id ? `РКО-${payload.rko_expense_id}` : null),
          payoutUsd: minorToUsd(payload.payout_delta_minor || 0),
          paidAt: payload.paid_at || log.created_at || null,
          reconciliationStatus: 'OK',
        });
      }
    } catch {
      // Non-fatal fallback
    }

    return linksByDealId;
  }

  static async getRegistry(query = {}, user = null) {
    const role = normalizeRole(user);
    if (!READ_ROLES.has(role)) {
      throw new AppError('Нет доступа к реестру комиссий маркетологов', 403, 'FORBIDDEN');
    }

    const reportQuery = {
      startDate: query.startDate || '2020-01-01',
      endDate: query.endDate || '2099-12-31',
      complex: 'ALL',
      block: 'ALL',
      salesSource: 'MARKETER',
    };

    const report = await ApartmentSalesReportService.getApartmentSalesReport(reportQuery, user);
    const marketerApartments = (report?.apartments || []).filter(
      (apt) => String(apt.salesSource || '').toUpperCase() === 'MARKETER'
    );

    const dealIds = marketerApartments.map((apt) => Number(apt.dealId)).filter((n) => Number.isInteger(n) && n > 0);
    const rkoLinksByDealId = await this.loadRkoLinksByDealId(dealIds);

    const allRows = marketerApartments.map((apt) => {
      const contractPriceMinor = Math.max(0, Number(apt.contractPriceMinor ?? toMinor(apt.contractPriceUsd)) || 0);
      const totalSettledMinor = Math.max(0, Number(apt.totalSettledMinor ?? toMinor(apt.totalSettledUsd)) || 0);
      const calculatedCommissionMinor = Math.max(0, Number(apt.calculatedCommissionMinor ?? toMinor(apt.calculatedCommissionUsd)) || 0);
      const approvedCommissionMinor = Math.max(0, Number(apt.approvedCommissionMinor ?? toMinor(apt.approvedCommissionUsd)) || 0);
      const paidCommissionMinor = Math.max(0, Number(apt.paidCommissionMinor ?? toMinor(apt.paidCommissionUsd)) || 0);
      const remainingCommissionMinor = Math.max(0, Number(apt.remainingCommissionMinor ?? toMinor(apt.remainingCommissionUsd)) || 0);
      const additionalAccrualMinor = Math.max(0, Number(apt.additionalAccrualMinor ?? toMinor(apt.additionalAccrualUsd)) || 0);
      const overpaidCommissionMinor = Math.max(0, Number(apt.overpaidCommissionMinor ?? toMinor(apt.overpaidCommissionUsd)) || 0);
      const rkoLinks = rkoLinksByDealId.get(Number(apt.dealId)) || [];

      return {
        dealId: Number(apt.dealId),
        contractNumber: apt.contractNumber || `Договор #${apt.dealId}`,
        contractDate: apt.contractDate || '',
        projectName: apt.projectName || '—',
        blockCode: apt.blockCode || '—',
        complexAndBlock: `${apt.projectName || '—'} · Блок ${apt.blockCode || '—'}`,
        unitNumber: String(apt.unitNumber || '—'),
        floorNumber: apt.floorNumber ?? null,
        areaM2: apt.areaM2 ?? 0,
        buyerName: apt.buyerName || '—',
        marketingPartnerId: apt.marketingPartnerId ?? null,
        marketingPartnerName: apt.marketingPartnerName || '—',
        marketerName: apt.marketerName || '',
        contractPriceMinor,
        contractPriceUsd: minorToUsd(contractPriceMinor),
        totalSettledMinor,
        totalSettledUsd: minorToUsd(totalSettledMinor),
        paymentPercent: Number(apt.paymentPercent || 0),
        commissionRateBp: Number(apt.commissionRateBp || 0),
        commissionRatePercent: Number(apt.commissionRatePercent || 0),
        calculatedCommissionMinor,
        calculatedCommissionUsd: minorToUsd(calculatedCommissionMinor),
        approvedCommissionMinor,
        approvedCommissionUsd: minorToUsd(approvedCommissionMinor),
        paidCommissionMinor,
        paidCommissionUsd: minorToUsd(paidCommissionMinor),
        remainingCommissionMinor,
        remainingCommissionUsd: minorToUsd(remainingCommissionMinor),
        additionalAccrualMinor,
        additionalAccrualUsd: minorToUsd(additionalAccrualMinor),
        overpaidCommissionMinor,
        overpaidCommissionUsd: minorToUsd(overpaidCommissionMinor),
        commissionStatus: apt.commissionStatus || 'NOT_CALCULATED',
        commissionStatusLabel: apt.commissionStatusLabel || COMMISSION_STATUS_LABELS[apt.commissionStatus] || 'Не рассчитана',
        reconciliationRequired: apt.commissionStatus === 'RECONCILIATION_REQUIRED' || rkoLinks.some((l) => l.reconciliationStatus === 'RECONCILIATION_REQUIRED'),
        accruedAt: apt.commissionAccruedAt || null,
        approvedAt: apt.commissionApprovedAt || null,
        paidAt: apt.commissionPaidAt || null,
        rkoLinks,
      };
    });

    const complexFilter = query.complex && query.complex !== 'ALL' ? String(query.complex).trim() : null;
    const blockFilter = query.block && query.block !== 'ALL' ? String(query.block).trim() : null;
    const partnerFilter = query.partnerId && query.partnerId !== 'ALL' ? String(query.partnerId).trim() : null;
    const rateFilter = query.rate !== undefined && query.rate !== '' && query.rate !== 'ALL' ? Number(query.rate) : null;
    const statusFilter = query.status && query.status !== 'ALL' ? String(query.status).trim().toUpperCase() : null;
    const searchFilter = query.search ? String(query.search).trim().toLocaleLowerCase('ru-RU') : '';

    const filteredRows = allRows.filter((row) => {
      if (complexFilter && row.projectName !== complexFilter) return false;
      if (blockFilter && row.blockCode !== blockFilter) return false;
      if (partnerFilter && String(row.marketingPartnerId ?? '') !== partnerFilter) return false;
      if (rateFilter !== null && Number.isFinite(rateFilter) && Math.round(row.commissionRatePercent) !== rateFilter) return false;
      if (statusFilter) {
        if (statusFilter === 'OVERPAID') {
          if (row.overpaidCommissionMinor <= 0) return false;
        } else if (statusFilter === 'NEEDS_ADDITIONAL_APPROVAL') {
          if (row.additionalAccrualMinor <= 0) return false;
        } else if (statusFilter === 'RECONCILIATION_REQUIRED') {
          if (!row.reconciliationRequired && row.commissionStatus !== 'RECONCILIATION_REQUIRED') return false;
        } else if (row.commissionStatus !== statusFilter) {
          return false;
        }
      }
      if (searchFilter) {
        const haystack = [
          row.contractNumber,
          row.buyerName,
          row.unitNumber,
          row.marketingPartnerName,
          row.projectName,
          row.blockCode,
        ]
          .join(' ')
          .toLocaleLowerCase('ru-RU');
        if (!haystack.includes(searchFilter)) return false;
      }
      return true;
    });

    filteredRows.sort((a, b) => {
      const dateCmp = String(b.contractDate || '').localeCompare(String(a.contractDate || ''));
      if (dateCmp !== 0) return dateCmp;
      return b.dealId - a.dealId;
    });

    const totals = aggregateRows(filteredRows);
    const overallSummary = aggregateRows(allRows);
    const partnerSummary = buildPartnerSummary(filteredRows);

    const complexes = Array.from(new Set(allRows.map((r) => r.projectName).filter((v) => v && v !== '—'))).sort((a, b) => a.localeCompare(b, 'ru'));
    const blocks = Array.from(new Set(allRows.map((r) => r.blockCode).filter((v) => v && v !== '—'))).sort((a, b) => a.localeCompare(b, 'ru'));
    const partnersMap = new Map();
    for (const p of report?.marketingPartners || []) {
      if (p?.id != null) partnersMap.set(String(p.id), { id: p.id, name: p.name });
    }
    for (const r of allRows) {
      if (r.marketingPartnerId != null && !partnersMap.has(String(r.marketingPartnerId))) {
        partnersMap.set(String(r.marketingPartnerId), { id: r.marketingPartnerId, name: r.marketingPartnerName });
      }
    }
    const partners = Array.from(partnersMap.values()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));

    const atomicIntegrationReady = await this.isAtomicRkoIntegrationReady();

    return {
      rows: filteredRows,
      totals,
      summary: overallSummary,
      partnerSummary,
      filterOptions: {
        complexes,
        blocks,
        partners,
      },
      permissions: {
        role,
        canView: true,
        canApprove: role === 'ADMIN',
        canPayout: RKO_ROLES.has(role) && atomicIntegrationReady,
        canPrepareRko: RKO_ROLES.has(role),
        payoutIntegrationEnabled: atomicIntegrationReady,
        payoutBlockedReason: atomicIntegrationReady
          ? null
          : 'Регистрация новых выплат через реестр временно заблокирована до применения атомарной интеграции с РКО (миграция 057). Доступны просмотр, расчёт, утверждение и подготовка РКО в кассе.',
        canCancel: role === 'ADMIN',
        canConfirmRefund: role === 'ADMIN' && atomicIntegrationReady,
        canExport: EXPORT_ROLES.has(role),
      },
      filters: {
        startDate: query.startDate || '',
        endDate: query.endDate || '',
        complex: query.complex || 'ALL',
        block: query.block || 'ALL',
        partnerId: query.partnerId || 'ALL',
        rate: query.rate || 'ALL',
        status: query.status || 'ALL',
        search: query.search || '',
      },
    };
  }

  static async getRkoCandidates(query = {}, user = null) {
    const role = normalizeRole(user);
    if (!RKO_ROLES.has(role)) {
      throw new AppError('Просмотр кандидатов РКО доступен только администратору и финансовому менеджеру', 403, 'FORBIDDEN');
    }

    const db = getSecureDB();
    let q = db
      .from('expenses')
      .select('id, reference, document_number, expense_date, recipient, category, description, amount_minor, currency, cash_desk_id, status, voided_at')
      .is('voided_at', null)
      .order('expense_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(120);

    const { data, error } = await q;
    if (error) {
      throw new AppError(`Ошибка загрузки РКО: ${error.message}`, 500, 'RKO_LOAD_FAILED');
    }

    const search = String(query.search || '').trim().toLocaleLowerCase('ru-RU');
    const onlyMarketing = query.onlyMarketing === 'true' || query.onlyMarketing === '1';

    const items = (data || [])
      .filter((row) => !['VOIDED', 'CANCELLED', 'REVERSED'].includes(String(row.status || '').toUpperCase()))
      .filter((row) => String(row.operation_type || '').toUpperCase() !== 'CONVERSION')
      .map((row) => ({
        id: Number(row.id),
        reference: row.reference || row.document_number || `РКО-${row.id}`,
        expenseDate: String(row.expense_date || '').slice(0, 10),
        recipient: row.recipient || '—',
        category: row.category || 'Прочее',
        description: String(row.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim(),
        amountUsd: Number((Number(row.amount_minor || 0) / 100).toFixed(2)),
        currency: String(row.currency || 'USD').toUpperCase(),
      }))
      .filter((item) => {
        if (onlyMarketing && !['маркетинг и реклама', 'marketing'].includes(item.category.toLowerCase())) {
          return false;
        }
        if (search) {
          const text = `${item.reference} ${item.recipient} ${item.category} ${item.description}`.toLocaleLowerCase('ru-RU');
          if (!text.includes(search)) return false;
        }
        return true;
      });

    return { items };
  }

  static async isAtomicRkoIntegrationReady() {
    try {
      const db = getSecureDB();
      const { error } = await db.from('marketing_commission_operations').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  }

  static async approveDealCommission(dealId, payload = {}, user = null) {
    const role = normalizeRole(user);
    if (role !== 'ADMIN') {
      throw new AppError(
        'Утверждение комиссий доступно только администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }

    const atomicReady = await this.isAtomicRkoIntegrationReady();
    if (!atomicReady) {
      return marketingAttributionService.updateDealCommission(
        dealId,
        { ...payload, action: 'APPROVE' },
        user
      );
    }

    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey).trim() : '';
    if (!idempotencyKey) {
      throw new AppError('Параметр idempotencyKey обязателен для утверждения комиссии', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const db = getSecureDB();
    const { data: rpcResult, error: rpcError } = await db.rpc('approve_marketing_commission_atomic', {
      p_deal_id: Number(dealId),
      p_actor_id: user?.id ? Number(user.id) : null,
      p_idempotency_key: idempotencyKey,
      p_notes: String(payload?.notes || payload?.reason || '').trim(),
    });

    if (rpcError) {
      const msg = String(rpcError.message || '');
      if (/could not find the function|does not exist/i.test(msg) || rpcError.code === 'PGRST202' || rpcError.code === '42883') {
        return marketingAttributionService.updateDealCommission(
          dealId,
          { ...payload, action: 'APPROVE' },
          user
        );
      }
      if (msg.includes('IDEMPOTENCY_CONFLICT') || msg.includes('REFUND_DOCUMENT_ALREADY_USED')) {
        throw new AppError(msg, 409, msg.includes('IDEMPOTENCY_CONFLICT') ? 'IDEMPOTENCY_CONFLICT' : 'REFUND_DOCUMENT_ALREADY_USED');
      }
      if (msg.includes('COMMISSION_RECONCILIATION_REQUIRED')) {
        throw new AppError(msg, 409, 'COMMISSION_RECONCILIATION_REQUIRED');
      }
      if (msg.includes('DEAL_NOT_FOUND')) {
        throw new AppError(msg, 404, 'DEAL_NOT_FOUND');
      }
      throw new AppError(msg || 'Ошибка атомарного утверждения комиссии', 400, 'COMMISSION_APPROVE_FAILED');
    }

    return rpcResult;
  }

  static async payoutDealCommission(dealId, payload = {}, user = null) {
    const role = normalizeRole(user);
    if (!RKO_ROLES.has(role)) {
      throw new AppError(
        'Регистрация выплаты комиссии доступна только финансовому менеджеру (FINANCE_MANAGER) или администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }

    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey).trim() : '';
    if (!idempotencyKey) {
      throw new AppError('Параметр idempotencyKey обязателен для регистрации выплаты', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const rawRkoId = payload?.rkoExpenseId ?? payload?.rko_expense_id;
    const rkoExpenseId = Number(rawRkoId);
    if (!Number.isInteger(rkoExpenseId) || rkoExpenseId <= 0) {
      throw new AppError('Для регистрации выплаты требуется привязка к проведённому документу РКО', 400, 'RKO_REQUIRED');
    }

    const payoutMinor = payload?.payoutAmountMinor !== undefined
      ? Math.round(Number(payload.payoutAmountMinor) || 0)
      : Math.round(Number(payload?.payoutAmountUsd ?? payload?.amountUsd ?? 0) * 100);
    if (payoutMinor <= 0) {
      throw new AppError('Сумма выплаты комиссии должна быть больше 0 USD', 400, 'INVALID_PAYOUT_AMOUNT');
    }

    const atomicReady = await this.isAtomicRkoIntegrationReady();
    if (!atomicReady) {
      throw new AppError(
        'Регистрация новых выплат через реестр временно заблокирована до применения атомарной интеграции с РКО (миграция 057). Используйте подготовку РКО в кассе.',
        409,
        'ATOMIC_RKO_INTEGRATION_REQUIRED'
      );
    }

    const db = getSecureDB();

    const { data: rpcResult, error: rpcError } = await db.rpc('record_marketing_commission_payout_atomic', {
      p_deal_id: Number(dealId),
      p_actor_id: user?.id ? Number(user.id) : null,
      p_payout_minor: payoutMinor,
      p_rko_expense_id: rkoExpenseId,
      p_expected_partner_name: payload?.expectedPartnerName || '',
      p_idempotency_key: idempotencyKey,
      p_notes: String(payload?.notes || '').trim(),
    });

    if (rpcError) {
      const msg = String(rpcError.message || '');
      if (/could not find the function|does not exist/i.test(msg) || rpcError.code === 'PGRST202' || rpcError.code === '42883') {
        throw new AppError(
          'Регистрация новых выплат через реестр временно заблокирована до применения атомарной интеграции с РКО (миграция 057).',
          409,
          'ATOMIC_RKO_INTEGRATION_REQUIRED'
        );
      }
      if (msg.includes('IDEMPOTENCY_CONFLICT') || msg.includes('RKO_ALREADY_LINKED')) {
        throw new AppError(msg, 409, msg.includes('IDEMPOTENCY_CONFLICT') ? 'IDEMPOTENCY_CONFLICT' : 'RKO_ALREADY_LINKED');
      }
      if (msg.includes('COMMISSION_RECONCILIATION_REQUIRED')) {
        throw new AppError(msg, 409, 'COMMISSION_RECONCILIATION_REQUIRED');
      }
      if (msg.includes('RKO_NOT_FOUND') || msg.includes('DEAL_NOT_FOUND')) {
        throw new AppError(msg, 404, msg.includes('RKO_NOT_FOUND') ? 'RKO_NOT_FOUND' : 'DEAL_NOT_FOUND');
      }
      if (msg.includes('PAYOUT_EXCEEDS_CALCULATED')) {
        throw new AppError(msg, 400, 'PAYOUT_EXCEEDS_CALCULATED');
      }
      if (msg.includes('PAYOUT_EXCEEDS_APPROVED')) {
        throw new AppError(msg, 400, 'PAYOUT_EXCEEDS_APPROVED');
      }
      if (msg.includes('RKO_RECIPIENT_MISMATCH') || msg.includes('RKO_RECIPIENT_REQUIRED')) {
        throw new AppError(msg, 400, msg.includes('RKO_RECIPIENT_REQUIRED') ? 'RKO_RECIPIENT_REQUIRED' : 'RKO_RECIPIENT_MISMATCH');
      }
      throw new AppError(msg || 'Ошибка атомарной регистрации выплаты комиссии', 400, 'COMMISSION_PAYOUT_FAILED');
    }

    return rpcResult;
  }

  static async cancelDealCommission(dealId, payload = {}, user = null) {
    return marketingAttributionService.updateDealCommission(
      dealId,
      { ...payload, action: 'CANCEL' },
      user
    );
  }

  static async confirmPayoutRefund(dealId, payload = {}, user = null) {
    const role = normalizeRole(user);
    if (role !== 'ADMIN') {
      throw new AppError(
        'Подтверждение возврата выплаченной комиссии доступно только администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }

    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey).trim() : '';
    if (!idempotencyKey) {
      throw new AppError('Параметр idempotencyKey обязателен', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const payoutOperationId = Number(payload?.payoutOperationId ?? payload?.payout_operation_id);
    if (!Number.isInteger(payoutOperationId) || payoutOperationId <= 0) {
      throw new AppError('Укажите корректный ID операции выплаты (payoutOperationId)', 400, 'INVALID_PAYOUT_OPERATION_ID');
    }

    const refundAmountMinor = payload?.refundAmountMinor !== undefined
      ? Math.round(Number(payload.refundAmountMinor) || 0)
      : Math.round(Number(payload?.refundAmountUsd ?? 0) * 100);
    if (refundAmountMinor <= 0) {
      throw new AppError('Сумма возврата должна быть больше 0 USD', 400, 'INVALID_REFUND_AMOUNT');
    }

    const refundDocumentRef = String(payload?.refundDocumentRef ?? payload?.refund_document_ref ?? '').trim();
    if (!refundDocumentRef) {
      throw new AppError('Укажите ссылку на документ возврата денег (ПКО/банковский документ)', 400, 'REFUND_DOCUMENT_REQUIRED');
    }

    const reason = String(payload?.reason || payload?.notes || '').trim();
    if (reason.length < 3) {
      throw new AppError('Укажите основание подтверждённого возврата денег', 400, 'REFUND_REASON_REQUIRED');
    }

    const atomicReady = await this.isAtomicRkoIntegrationReady();
    if (!atomicReady) {
      throw new AppError(
        'Подтверждение возврата выплаты доступно только после применения атомарной интеграции с РКО (миграция 057).',
        409,
        'ATOMIC_RKO_INTEGRATION_REQUIRED'
      );
    }

    const db = getSecureDB();
    const { data: rpcResult, error: rpcError } = await db.rpc('confirm_marketing_commission_payout_refund_atomic', {
      p_deal_id: Number(dealId),
      p_actor_id: user?.id ? Number(user.id) : null,
      p_payout_operation_id: payoutOperationId,
      p_refund_amount_minor: refundAmountMinor,
      p_refund_document_ref: refundDocumentRef,
      p_idempotency_key: idempotencyKey,
      p_reason: reason,
    });

    if (rpcError) {
      const msg = String(rpcError.message || '');
      if (/could not find the function|does not exist/i.test(msg) || rpcError.code === 'PGRST202' || rpcError.code === '42883') {
        throw new AppError(
          'Подтверждение возврата выплаты доступно только после применения миграции 057.',
          409,
          'ATOMIC_RKO_INTEGRATION_REQUIRED'
        );
      }
      if (msg.includes('IDEMPOTENCY_CONFLICT') || msg.includes('REFUND_DOCUMENT_ALREADY_USED')) {
        throw new AppError(msg, 409, msg.includes('IDEMPOTENCY_CONFLICT') ? 'IDEMPOTENCY_CONFLICT' : 'REFUND_DOCUMENT_ALREADY_USED');
      }
      if (msg.includes('DEAL_NOT_FOUND') || msg.includes('COMMISSION_NOT_FOUND') || msg.includes('PAYOUT_OPERATION_NOT_FOUND')) {
        throw new AppError(msg, 404, 'NOT_FOUND');
      }
      throw new AppError(msg || 'Ошибка подтверждения возврата выплаченной комиссии', 400, 'CONFIRM_PAYOUT_REFUND_FAILED');
    }

    return rpcResult;
  }

  static async reconcilePayoutWithNewRko(dealId, payload = {}, user = null) {
    const role = normalizeRole(user);
    if (role !== 'ADMIN') {
      throw new AppError(
        'Завершение сверки с привязкой нового РКО доступно только администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }

    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey).trim() : '';
    if (!idempotencyKey) {
      throw new AppError('Параметр idempotencyKey обязателен', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const payoutOperationId = Number(payload?.payoutOperationId ?? payload?.payout_operation_id);
    if (!Number.isInteger(payoutOperationId) || payoutOperationId <= 0) {
      throw new AppError('Укажите корректный ID операции выплаты (payoutOperationId)', 400, 'INVALID_PAYOUT_OPERATION_ID');
    }

    const newRkoExpenseId = Number(payload?.newRkoExpenseId ?? payload?.new_rko_expense_id ?? payload?.rkoExpenseId);
    if (!Number.isInteger(newRkoExpenseId) || newRkoExpenseId <= 0) {
      throw new AppError('Укажите корректный ID нового проведённого РКО (newRkoExpenseId)', 400, 'RKO_REQUIRED');
    }

    const reason = String(payload?.reason || payload?.notes || '').trim();
    if (reason.length < 3) {
      throw new AppError('Укажите основание завершения сверки с заменой РКО', 400, 'RECONCILE_REASON_REQUIRED');
    }

    const atomicReady = await this.isAtomicRkoIntegrationReady();
    if (!atomicReady) {
      throw new AppError(
        'Сверка выплаты с заменой РКО доступна только после применения миграции 057.',
        409,
        'ATOMIC_RKO_INTEGRATION_REQUIRED'
      );
    }

    const db = getSecureDB();
    const { data: rpcResult, error: rpcError } = await db.rpc('reconcile_marketing_commission_payout_with_rko_atomic', {
      p_deal_id: Number(dealId),
      p_actor_id: user?.id ? Number(user.id) : null,
      p_payout_operation_id: payoutOperationId,
      p_new_rko_expense_id: newRkoExpenseId,
      p_expected_partner_name: payload?.expectedPartnerName || '',
      p_idempotency_key: idempotencyKey,
      p_reason: reason,
    });

    if (rpcError) {
      const msg = String(rpcError.message || '');
      if (/could not find the function|does not exist/i.test(msg) || rpcError.code === 'PGRST202' || rpcError.code === '42883') {
        throw new AppError('Сверка выплаты доступна только после применения миграции 057.', 409, 'ATOMIC_RKO_INTEGRATION_REQUIRED');
      }
      if (msg.includes('IDEMPOTENCY_CONFLICT') || msg.includes('RKO_ALREADY_LINKED')) {
        throw new AppError(msg, 409, msg.includes('IDEMPOTENCY_CONFLICT') ? 'IDEMPOTENCY_CONFLICT' : 'RKO_ALREADY_LINKED');
      }
      if (msg.includes('RKO_NOT_FOUND') || msg.includes('DEAL_NOT_FOUND') || msg.includes('COMMISSION_NOT_FOUND') || msg.includes('PAYOUT_OPERATION_NOT_FOUND')) {
        throw new AppError(msg, 404, 'NOT_FOUND');
      }
      throw new AppError(msg || 'Ошибка завершения сверки с заменой РКО', 400, 'RECONCILE_PAYOUT_RKO_FAILED');
    }

    return rpcResult;
  }

  static async exportWorkbook(query = {}, user = null) {
    const role = normalizeRole(user);
    if (!EXPORT_ROLES.has(role)) {
      throw new AppError('Экспорт реестра комиссий доступен только администратору, директору и финансовому менеджеру', 403, 'FORBIDDEN');
    }

    const data = await this.getRegistry(query, user);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TOZON CRM';
    wb.title = 'Реестр комиссий маркетологов';
    wb.calcProperties.fullCalcOnLoad = true;

    // Sheet 1: Deals Registry
    const ws = wb.addWorksheet('Реестр комиссий');
    const cols = [
      { header: '№ договора', key: 'contractNumber', width: 18 },
      { header: 'Дата договора', key: 'contractDate', width: 14 },
      { header: 'ЖК и блок', key: 'complexAndBlock', width: 26 },
      { header: 'Кв.', key: 'unitNumber', width: 10 },
      { header: 'Покупатель', key: 'buyerName', width: 26 },
      { header: 'Маркетинговый партнёр', key: 'marketingPartnerName', width: 24 },
      { header: 'Сумма договора, USD', key: 'contractPriceUsd', width: 18 },
      { header: 'Получено, USD', key: 'totalSettledUsd', width: 18 },
      { header: 'Оплата, %', key: 'paymentPercent', width: 12 },
      { header: 'Ставка, %', key: 'commissionRatePercent', width: 12 },
      { header: 'Расчётная комиссия, USD', key: 'calculatedCommissionUsd', width: 20 },
      { header: 'Утверждённая комиссия, USD', key: 'approvedCommissionUsd', width: 20 },
      { header: 'Выплачено, USD', key: 'paidCommissionUsd', width: 18 },
      { header: 'Остаток к выплате, USD', key: 'remainingCommissionUsd', width: 20 },
      { header: 'К доутверждению, USD', key: 'additionalAccrualUsd', width: 18 },
      { header: 'Статус комиссии', key: 'commissionStatusLabel', width: 22 },
      { header: 'Переплата, USD', key: 'overpaidCommissionUsd', width: 16 },
      { header: 'Связь с РКО', key: 'rkoRefs', width: 22 },
    ];
    ws.columns = cols.map(({ key, width }) => ({ key, width }));

    ws.mergeCells(1, 1, 1, cols.length);
    ws.getCell(1, 1).value = 'TOZON CRM — РЕЕСТР КОМИССИЙ МАРКЕТОЛОГОВ';
    ws.getCell(1, 1).font = { name: 'Arial', bold: true, size: 14, color: { argb: '173C55' } };
    ws.getRow(1).height = 26;

    ws.mergeCells(2, 1, 2, cols.length);
    ws.getCell(2, 1).value = `Сформировано: ${new Date().toISOString().slice(0, 10)} · Договоров: ${data.totals.dealsCount} · Расчётная комиссия: ${data.totals.calculatedCommissionUsd.toFixed(2)} USD`;
    ws.getCell(2, 1).font = { name: 'Arial', size: 10, color: { argb: '475569' } };

    const headerRow = ws.getRow(4);
    headerRow.values = cols.map((c) => c.header);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '173C55' } };
      cell.font = { name: 'Arial', bold: true, size: 10, color: { argb: 'FFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    for (const [idx, r] of data.rows.entries()) {
      const excelRow = ws.addRow({
        contractNumber: safeCell(r.contractNumber),
        contractDate: safeCell(r.contractDate),
        complexAndBlock: safeCell(r.complexAndBlock),
        unitNumber: safeCell(r.unitNumber),
        buyerName: safeCell(r.buyerName),
        marketingPartnerName: safeCell(r.marketingPartnerName),
        contractPriceUsd: r.contractPriceUsd,
        totalSettledUsd: r.totalSettledUsd,
        paymentPercent: r.paymentPercent,
        commissionRatePercent: r.commissionRatePercent,
        calculatedCommissionUsd: r.calculatedCommissionUsd,
        approvedCommissionUsd: r.approvedCommissionUsd,
        paidCommissionUsd: r.paidCommissionUsd,
        remainingCommissionUsd: r.remainingCommissionUsd,
        additionalAccrualUsd: r.additionalAccrualUsd,
        commissionStatusLabel: safeCell(r.commissionStatusLabel),
        overpaidCommissionUsd: r.overpaidCommissionUsd,
        rkoRefs: safeCell((r.rkoLinks || []).map((l) => l.rkoReference).filter(Boolean).join(', ') || '—'),
      });
      excelRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10, color: { argb: '1E293B' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'F8FAFC' : 'FFFFFF' } };
        cell.border = { bottom: { style: 'hair', color: { argb: 'CBD5E1' } } };
        if ([7, 8, 11, 12, 13, 14, 15, 17].includes(colNumber)) {
          cell.numFmt = '#,##0.00';
        } else if ([9, 10].includes(colNumber)) {
          cell.numFmt = '0.00';
        }
      });
    }

    const totalRow = ws.addRow({
      contractNumber: 'ИТОГО',
      contractDate: `${data.totals.dealsCount} дог.`,
      complexAndBlock: '',
      unitNumber: '',
      buyerName: '',
      marketingPartnerName: '',
      contractPriceUsd: data.totals.contractPriceUsd,
      totalSettledUsd: data.totals.totalSettledUsd,
      paymentPercent: data.totals.avgPaymentPercent,
      commissionRatePercent: '',
      calculatedCommissionUsd: data.totals.calculatedCommissionUsd,
      approvedCommissionUsd: data.totals.approvedCommissionUsd,
      paidCommissionUsd: data.totals.paidCommissionUsd,
      remainingCommissionUsd: data.totals.remainingCommissionUsd,
      additionalAccrualUsd: data.totals.additionalAccrualUsd,
      commissionStatusLabel: '',
      overpaidCommissionUsd: data.totals.overpaidCommissionUsd,
      rkoRefs: '',
    });
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', bold: true, size: 10, color: { argb: '0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2E8F0' } };
      if ([7, 8, 11, 12, 13, 14, 15, 17].includes(colNumber)) {
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 9) {
        cell.numFmt = '0.00';
      }
    });

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    // Sheet 2: Partner Summary
    const wsPartner = wb.addWorksheet('Сводка по партнёрам');
    const pCols = [
      { header: 'Маркетинговый партнёр', key: 'partnerName', width: 28 },
      { header: 'Договоров', key: 'dealsCount', width: 12 },
      { header: 'Ставка 0%', key: 'r0', width: 11 },
      { header: 'Ставка 2%', key: 'r2', width: 11 },
      { header: 'Ставка 3%', key: 'r3', width: 11 },
      { header: 'Ставка 4%', key: 'r4', width: 11 },
      { header: 'Сумма продаж, USD', key: 'contractPriceUsd', width: 18 },
      { header: 'Получено от покупателей, USD', key: 'totalSettledUsd', width: 22 },
      { header: 'Расчётная комиссия, USD', key: 'calculatedCommissionUsd', width: 20 },
      { header: 'Утверждено, USD', key: 'approvedCommissionUsd', width: 18 },
      { header: 'Выплачено, USD', key: 'paidCommissionUsd', width: 18 },
      { header: 'Остаток к выплате, USD', key: 'remainingCommissionUsd', width: 20 },
      { header: 'К доутверждению, USD', key: 'additionalAccrualUsd', width: 20 },
      { header: 'Переплата, USD', key: 'overpaidCommissionUsd', width: 16 },
    ];
    wsPartner.columns = pCols.map(({ key, width }) => ({ key, width }));

    wsPartner.mergeCells(1, 1, 1, pCols.length);
    wsPartner.getCell(1, 1).value = 'TOZON CRM — СВОДКА ПО МАРКЕТИНГОВЫМ ПАРТНЁРАМ';
    wsPartner.getCell(1, 1).font = { name: 'Arial', bold: true, size: 14, color: { argb: '173C55' } };
    wsPartner.getRow(1).height = 26;

    const pHeaderRow = wsPartner.getRow(3);
    pHeaderRow.values = pCols.map((c) => c.header);
    pHeaderRow.height = 28;
    pHeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '173C55' } };
      cell.font = { name: 'Arial', bold: true, size: 10, color: { argb: 'FFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    for (const [idx, p] of data.partnerSummary.entries()) {
      const pRow = wsPartner.addRow({
        partnerName: safeCell(p.partnerName),
        dealsCount: p.dealsCount,
        r0: p.rateBreakdown['0'] || 0,
        r2: p.rateBreakdown['2'] || 0,
        r3: p.rateBreakdown['3'] || 0,
        r4: p.rateBreakdown['4'] || 0,
        contractPriceUsd: p.contractPriceUsd,
        totalSettledUsd: p.totalSettledUsd,
        calculatedCommissionUsd: p.calculatedCommissionUsd,
        approvedCommissionUsd: p.approvedCommissionUsd,
        paidCommissionUsd: p.paidCommissionUsd,
        remainingCommissionUsd: p.remainingCommissionUsd,
        additionalAccrualUsd: p.additionalAccrualUsd,
        overpaidCommissionUsd: p.overpaidCommissionUsd,
      });
      pRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10, color: { argb: '1E293B' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'F8FAFC' : 'FFFFFF' } };
        if (colNumber >= 7) cell.numFmt = '#,##0.00';
      });
    }

    const pTotalRow = wsPartner.addRow({
      partnerName: 'ИТОГО',
      dealsCount: data.totals.dealsCount,
      r0: data.totals.rateBreakdown['0'] || 0,
      r2: data.totals.rateBreakdown['2'] || 0,
      r3: data.totals.rateBreakdown['3'] || 0,
      r4: data.totals.rateBreakdown['4'] || 0,
      contractPriceUsd: data.totals.contractPriceUsd,
      totalSettledUsd: data.totals.totalSettledUsd,
      calculatedCommissionUsd: data.totals.calculatedCommissionUsd,
      approvedCommissionUsd: data.totals.approvedCommissionUsd,
      paidCommissionUsd: data.totals.paidCommissionUsd,
      remainingCommissionUsd: data.totals.remainingCommissionUsd,
      additionalAccrualUsd: data.totals.additionalAccrualUsd,
      overpaidCommissionUsd: data.totals.overpaidCommissionUsd,
    });
    pTotalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', bold: true, size: 10, color: { argb: '0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2E8F0' } };
      if (colNumber >= 7) cell.numFmt = '#,##0.00';
    });

    wsPartner.views = [{ state: 'frozen', ySplit: 3 }];

    return wb.xlsx.writeBuffer();
  }
}

