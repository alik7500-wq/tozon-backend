import ExcelJS from 'exceljs';
import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import {
  SALES_SOURCES,
  SALES_SOURCE_LABELS,
  AUDIT_ACTION_SALES_SOURCE,
  AUDIT_ACTION_COMMISSION,
  DICTIONARY_TYPE_PARTNER,
  decodePartnerFromDictionaryRow,
  normalizePartnerFromTableRow,
  resolveDealAttributionAndCommission,
} from './marketingAttribution.service.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CANONICAL_BLOCKS = Object.freeze([
  { projectKey: 'TOZON PLAZA', projectName: 'TOZON PLAZA', blockCode: 'А', blockName: 'Блок А', sortOrder: 1 },
  { projectKey: 'TOZON PLAZA', projectName: 'TOZON PLAZA', blockCode: 'Б', blockName: 'Блок Б', sortOrder: 2 },
  { projectKey: 'TOZON PLAZA-2', projectName: 'TOZON PLAZA-2', blockCode: 'В', blockName: 'Блок В', sortOrder: 3 },
  { projectKey: 'TOZON PLAZA-2', projectName: 'TOZON PLAZA-2', blockCode: 'Г', blockName: 'Блок Г', sortOrder: 4 }
]);

const LATIN_TO_CYRILLIC_BLOCK = {
  A: 'А',
  B: 'Б',
  V: 'В',
  G: 'Г'
};

/**
 * Normalizes project/complex record or query filter to canonical complex name:
 * 'TOZON PLAZA' or 'TOZON PLAZA-2'.
 */
export function normalizeComplexName(input) {
  if (!input) return '';
  const rawName = typeof input === 'object'
    ? `${input.name || ''} ${input.code || ''}`.trim()
    : String(input).trim();

  if (!rawName) return '';
  const upper = rawName.toUpperCase();
  if (upper === 'ALL' || upper === 'ВСЕ') return 'ALL';

  if (/(?:PLAZA|ПЛАЗА)[-\s]+2(?:\b|$)/i.test(upper)) {
    return 'TOZON PLAZA-2';
  }

  if (
    upper.includes('TOZON PLAZA') ||
    upper.includes('ТОЗОН ПЛАЗА') ||
    upper.includes('25601')
  ) {
    return 'TOZON PLAZA';
  }

  return rawName.replace(/^ЖК\s+/i, '').trim();
}

/**
 * Normalizes building/block record or query filter to canonical block letter:
 * 'А', 'Б', 'В', 'Г'.
 */
export function normalizeBlockCode(input) {
  if (!input) return '';
  const raw = typeof input === 'object'
    ? `${input.code || ''} ${input.name || ''}`.trim()
    : String(input).trim();

  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (upper === 'ALL' || upper === 'ВСЕ') return 'ALL';

  const singleNormalized = LATIN_TO_CYRILLIC_BLOCK[upper] || upper;
  if (['А', 'Б', 'В', 'Г'].includes(singleNormalized)) {
    return singleNormalized;
  }

  const match = upper.match(/БЛОК[-\s]*([АБВГABVG])/i) || upper.match(/(?:^|[\s-])([АБВГABVG])(?:$|[\s-])/i);
  if (match && match[1]) {
    const ch = match[1].toUpperCase();
    return LATIN_TO_CYRILLIC_BLOCK[ch] || ch;
  }

  return raw.replace(/^Блок\s+/i, '').trim();
}

/**
 * Normalizes sales source filter: 'ALL', 'DIRECT', 'MARKETER', 'UNSPECIFIED'.
 */
export function normalizeSalesSourceFilter(input) {
  if (!input) return 'ALL';
  const upper = String(input).trim().toUpperCase();
  if (upper === 'ALL' || upper === 'ВСЕ') return 'ALL';
  if (upper === SALES_SOURCES.DIRECT || upper === 'ПРЯМЫЕ') return SALES_SOURCES.DIRECT;
  if (upper === SALES_SOURCES.MARKETER || upper === 'МАРКЕТОЛОГИ') return SALES_SOURCES.MARKETER;
  if (upper === SALES_SOURCES.UNSPECIFIED || upper === 'UNKNOWN') return SALES_SOURCES.UNSPECIFIED;
  return 'ALL';
}

/**
 * Resolves a date field to YYYY-MM-DD format (Asia/Dushanbe).
 */
export function resolveIsoDate(rawValue) {
  if (!rawValue) return null;
  const raw = String(rawValue).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z?$/.test(raw)) {
    return raw.slice(0, 10);
  }
  const parsed = getBusinessDate(raw);
  if (parsed && DATE_RE.test(parsed)) return parsed;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

/**
 * Resolves the contract conclusion date in YYYY-MM-DD format (Asia/Dushanbe).
 * Priority: deal.deal_date -> deal.signed_at -> deal.created_at.
 */
export function resolveContractDate(deal) {
  if (!deal) return null;

  if (deal.deal_date) {
    const raw = String(deal.deal_date).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return raw.slice(0, 10);
    }
    const parsed = resolveIsoDate(raw);
    if (parsed) return parsed;
  }

  if (deal.signed_at) {
    const parsed = resolveIsoDate(deal.signed_at);
    if (parsed) return parsed;
  }

  if (deal.created_at) {
    const parsed = resolveIsoDate(deal.created_at);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Resolves payment date in YYYY-MM-DD format (Asia/Dushanbe).
 */
export function resolvePaymentDate(payment) {
  if (!payment) return null;
  if (payment.payment_date) {
    const raw = String(payment.payment_date).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return raw.slice(0, 10);
    }
    const parsed = resolveIsoDate(raw);
    if (parsed) return parsed;
  }
  if (payment.created_at) {
    return resolveIsoDate(payment.created_at);
  }
  return null;
}

/**
 * Checks whether a payment record is voided/cancelled.
 */
export function isVoidedPayment(payment) {
  if (!payment) return true;
  if (String(payment.status || '').toUpperCase() === 'VOIDED') return true;
  if (String(payment.status || '').toUpperCase() === 'REVERSED') return true;
  if (String(payment.status || '').toUpperCase() === 'CANCELLED') return true;
  if (String(payment.comment || '').includes('[АННУЛИРОВАНО]')) return true;
  return false;
}

/**
 * Determines whether an active payment is a non-cash barter settlement.
 */
export function isBarterPayment(payment, barterDeskIds = new Set()) {
  if (!payment) return false;
  const settlementMethod = String(payment.settlement_method || '').toUpperCase();
  if (settlementMethod === 'NON_CASH_BARTER' || settlementMethod === 'BARTER') {
    return true;
  }
  const paymentMethod = String(payment.payment_method || '').toUpperCase();
  if (paymentMethod === 'BARTER' || paymentMethod === 'NON_CASH_BARTER') {
    return true;
  }
  if (payment.cash_desk_id && barterDeskIds.has(String(payment.cash_desk_id))) {
    return true;
  }
  const comment = String(payment.comment || '').toLowerCase();
  if (comment.includes('касса: бартер') || comment.includes('зачет бартер') || comment.includes('зачёт бартер')) {
    return true;
  }
  return false;
}

/**
 * Converts area_m2_x100 integer (or fallback area_m2) to integer hundredths of m².
 */
export function resolveAreaX100(unit) {
  if (!unit) return 0;
  if (unit.area_m2_x100 !== undefined && unit.area_m2_x100 !== null && Number.isFinite(Number(unit.area_m2_x100))) {
    return Math.max(0, Math.round(Number(unit.area_m2_x100)));
  }
  if (unit.area_m2 !== undefined && unit.area_m2 !== null && Number.isFinite(Number(unit.area_m2))) {
    return Math.max(0, Math.round(Number(unit.area_m2) * 100));
  }
  return 0;
}

export function formatAreaM2(areaX100) {
  return Number(((Number(areaX100) || 0) / 100).toFixed(2));
}

export function formatMoneyUsd(amountMinor) {
  return Number(((Number(amountMinor) || 0) / 100).toFixed(2));
}

export function calculatePercent(partMinor, totalMinor) {
  const total = Number(totalMinor) || 0;
  const part = Number(partMinor) || 0;
  if (total <= 0 || part <= 0) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

export function formatDateRu(isoDate) {
  if (!isoDate || !DATE_RE.test(String(isoDate))) return String(isoDate || '—');
  const [y, m, d] = String(isoDate).split('-');
  return `${d}.${m}.${y}`;
}

export function getDushanbeTimestampLabel(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Dushanbe',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(now);
  } catch {
    return getBusinessDate(now) || '';
  }
}

/**
 * Extracts normalized hierarchy metadata from a unit record.
 */
function extractUnitHierarchy(unit, fallbackDeal = null) {
  const floorObj = Array.isArray(unit?.floors) ? unit.floors[0] : unit?.floors;
  const sectionObj = Array.isArray(floorObj?.sections) ? floorObj.sections[0] : floorObj?.sections;
  const buildingObj = Array.isArray(sectionObj?.buildings) ? sectionObj.buildings[0] : sectionObj?.buildings;
  const projectObj = Array.isArray(buildingObj?.projects) ? buildingObj.projects[0] : buildingObj?.projects;

  const projectName = normalizeComplexName(
    projectObj || unit?.project_name || unit?.project || fallbackDeal?.project_name || fallbackDeal?.project
  );
  const blockCode = normalizeBlockCode(
    buildingObj || unit?.block_code || unit?.block || fallbackDeal?.block_code || fallbackDeal?.block
  );

  return {
    projectId: projectObj?.id ?? buildingObj?.project_id ?? unit?.project_id ?? null,
    projectName,
    rawProjectName: projectObj?.name || projectName,
    buildingId: buildingObj?.id ?? sectionObj?.building_id ?? unit?.building_id ?? null,
    blockCode,
    blockName: buildingObj?.name || (blockCode ? `Блок ${blockCode}` : ''),
    floorNumber: floorObj?.floor_number ?? unit?.floor_number ?? null
  };
}

function createEmptyBlockRow(meta) {
  return {
    key: meta.key,
    projectId: meta.projectId ?? null,
    projectName: meta.projectName,
    rawProjectName: meta.rawProjectName || meta.projectName,
    buildingId: meta.buildingId ?? null,
    blockCode: meta.blockCode,
    blockName: meta.blockName || `Блок ${meta.blockCode}`,
    totalApartments: 0,
    blockedCount: 0,
    sellableApartments: 0,
    availableStartCount: 0,
    reservedStartCount: 0,
    soldCount: 0,
    directSoldCount: 0,
    marketerSoldCount: 0,
    unspecifiedSoldCount: 0,
    availableEndCount: 0,
    reservedEndCount: 0,
    cancelledInPeriodCount: 0,
    soldAreaX100: 0,
    soldAreaM2: 0,
    salesAmountMinor: 0,
    salesAmountUsd: 0,
    directSalesAmountMinor: 0,
    directSalesAmountUsd: 0,
    marketerSalesAmountMinor: 0,
    marketerSalesAmountUsd: 0,
    unspecifiedSalesAmountMinor: 0,
    unspecifiedSalesAmountUsd: 0,
    paidDownPaymentMinor: 0,
    paidDownPaymentUsd: 0,
    paidDownPaymentPercent: 0,
    directPaidDownPaymentMinor: 0,
    directPaidDownPaymentUsd: 0,
    directPaidDownPaymentPercent: 0,
    marketerPaidDownPaymentMinor: 0,
    marketerPaidDownPaymentUsd: 0,
    marketerPaidDownPaymentPercent: 0,
    unspecifiedPaidDownPaymentMinor: 0,
    unspecifiedPaidDownPaymentUsd: 0,
    unspecifiedPaidDownPaymentPercent: 0,
    paidCashMinor: 0,
    paidCashUsd: 0,
    paidBarterMinor: 0,
    paidBarterUsd: 0,
    totalSettledMinor: 0,
    totalSettledUsd: 0,
    remainingDebtMinor: 0,
    remainingDebtUsd: 0,
    overpaidMinor: 0,
    overpaidUsd: 0,
    paidPercent: 0,
    debtPercent: 0,
    calculatedCommissionMinor: 0,
    calculatedCommissionUsd: 0,
    approvedCommissionMinor: 0,
    approvedCommissionUsd: 0,
    paidCommissionMinor: 0,
    paidCommissionUsd: 0,
    remainingCommissionMinor: 0,
    remainingCommissionUsd: 0,
    apartments: []
  };
}

export class ApartmentSalesReportService {
  /**
   * Resolves default and validated filter parameters.
   * Default period: 1st of current month to today in Asia/Dushanbe.
   */
  static resolveFilters(query = {}, now = new Date()) {
    const today = getBusinessDate(now);
    const firstOfMonth = `${today.slice(0, 8)}01`;

    const startDate = query.startDate ? String(query.startDate).trim() : firstOfMonth;
    const endDate = query.endDate ? String(query.endDate).trim() : today;

    if (!DATE_RE.test(startDate)) {
      throw new AppError('Некорректный формат даты начала периода (ожидается ГГГГ-ММ-ДД)', 400);
    }
    if (!DATE_RE.test(endDate)) {
      throw new AppError('Некорректный формат даты окончания периода (ожидается ГГГГ-ММ-ДД)', 400);
    }
    if (startDate > endDate) {
      throw new AppError('Дата начала периода не может быть позже даты окончания периода', 400);
    }

    const rawComplex = query.complex || query.project || query.projectId || 'ALL';
    const rawBlock = query.block || query.buildingId || 'ALL';

    const complex = normalizeComplexName(rawComplex) || 'ALL';
    let block = normalizeBlockCode(rawBlock) || 'ALL';

    if (complex === 'TOZON PLAZA' && !['ALL', 'А', 'Б'].includes(block)) {
      block = 'ALL';
    } else if (complex === 'TOZON PLAZA-2' && !['ALL', 'В', 'Г'].includes(block)) {
      block = 'ALL';
    }

    const salesSource = normalizeSalesSourceFilter(query.salesSource || query.source || 'ALL');
    const rawPartnerId = query.partnerId ?? query.marketingPartnerId ?? 'ALL';
    const partnerId = rawPartnerId === undefined || rawPartnerId === null || String(rawPartnerId).trim() === '' || String(rawPartnerId).toUpperCase() === 'ALL'
      ? 'ALL'
      : String(rawPartnerId).trim();

    return {
      startDate,
      endDate,
      complex,
      block,
      salesSource,
      partnerId,
    };
  }

  /**
   * Fetches buildings, apartments inventory, all deals with payments/leads, dictionaries, users, and audit logs from Supabase.
   */
  static async fetchReportDataFromDB(db = getSecureDB()) {
    const [buildingsRes, unitsRes, dealsRes, dictsRes, usersRes, auditLogsRes] = await Promise.all([
      db
        .from('buildings')
        .select('id, name, code, sort_order, project_id, archived_at, projects ( id, name, code, archived_at )')
        .is('archived_at', null)
        .order('project_id', { ascending: true })
        .order('sort_order', { ascending: true }),
      db
        .from('units')
        .select(`
          id,
          unit_number,
          unit_kind,
          rooms,
          area_m2_x100,
          status,
          archived_at,
          created_at,
          updated_at,
          floors (
            id,
            floor_number,
            name,
            sections (
              id,
              name,
              building_id,
              buildings (
                id,
                name,
                code,
                sort_order,
                project_id,
                projects (
                  id,
                  name,
                  code
                )
              )
            )
          )
        `)
        .eq('unit_kind', 'APARTMENT')
        .is('archived_at', null),
      db
        .from('deals')
        .select(`
          id,
          unit_id,
          lead_id,
          responsible_user_id,
          status,
          payment_type,
          contract_number,
          deal_date,
          signed_at,
          created_at,
          cancelled_at,
          reservation_expires_at,
          base_price_minor,
          discount_minor,
          final_price_minor,
          down_payment_minor,
          barter_amount_minor,
          barter_description,
          refund_amount_minor,
          currency,
          leads (
            id,
            full_name,
            phone,
            source,
            responsible_user_id
          ),
          units (
            id,
            unit_number,
            unit_kind,
            rooms,
            area_m2_x100,
            status,
            archived_at,
            floors (
              id,
              floor_number,
              name,
              sections (
                id,
                name,
                building_id,
                buildings (
                  id,
                  name,
                  code,
                  sort_order,
                  project_id,
                  projects (
                    id,
                    name,
                    code
                  )
                )
              )
            )
          ),
          payments (
            id,
            deal_id,
            amount_minor,
            currency,
            amount_tjs,
            exchange_rate,
            payment_date,
            settlement_method,
            cash_desk_id,
            status,
            comment,
            created_at
          )
        `),
      db
        .from('dictionaries')
        .select('id, type, code, name, is_active, sort_order, created_at, updated_at')
        .in('type', ['CASH_DESK', DICTIONARY_TYPE_PARTNER]),
      db
        .from('users')
        .select('id, name, role'),
      db
        .from('deal_audit_logs')
        .select('id, deal_id, user_id, action, changes_json, created_at')
        .in('action', [AUDIT_ACTION_SALES_SOURCE, AUDIT_ACTION_COMMISSION])
        .order('created_at', { ascending: true })
    ]);

    if (buildingsRes.error) {
      throw new AppError(`Ошибка загрузки блоков: ${buildingsRes.error.message}`, 500);
    }
    if (unitsRes.error) {
      throw new AppError(`Ошибка загрузки квартир: ${unitsRes.error.message}`, 500);
    }
    if (dealsRes.error) {
      throw new AppError(`Ошибка загрузки договоров: ${dealsRes.error.message}`, 500);
    }

    // Optional probe for dedicated marketing_partners and unit_status_history if migrations 055/056 are applied
    let dedicatedPartners = [];
    let unitStatusHistory = [];
    try {
      const { data: mpData, error: mpErr } = await db
        .from('marketing_partners')
        .select('*')
        .order('name', { ascending: true });
      if (!mpErr && Array.isArray(mpData)) {
        dedicatedPartners = mpData;
      }
    } catch {
      // Migration 055 not applied yet; fallback to dictionaries is used automatically
    }

    try {
      const { data: ushData, error: ushErr } = await db
        .from('unit_status_history')
        .select('id, unit_id, old_status, new_status, deal_id, reason, changed_at')
        .order('changed_at', { ascending: true });
      if (!ushErr && Array.isArray(ushData)) {
        unitStatusHistory = ushData;
      }
    } catch {
      // Migration 056 not applied yet
    }

    return {
      buildings: buildingsRes.data || [],
      units: unitsRes.data || [],
      deals: dealsRes.data || [],
      dictionaries: dictsRes?.data || [],
      users: usersRes?.data || [],
      dealAuditLogs: auditLogsRes?.data || [],
      marketingPartners: dedicatedPartners,
      unitStatusHistory,
    };
  }

  /**
   * Resolves contractual price in USD minor units (cents) for a deal.
   * Priority: final_price_minor -> (base_price_minor - discount_minor) -> final_price * 100.
   */
  static resolveContractPriceMinor(deal) {
    if (!deal) return 0;
    if (deal.final_price_minor !== undefined && deal.final_price_minor !== null && Number.isFinite(Number(deal.final_price_minor))) {
      return Math.max(0, Math.round(Number(deal.final_price_minor)));
    }
    if (deal.base_price_minor !== undefined && deal.base_price_minor !== null && Number.isFinite(Number(deal.base_price_minor))) {
      const base = Math.round(Number(deal.base_price_minor));
      const disc = Math.round(Number(deal.discount_minor) || 0);
      return Math.max(0, base - disc);
    }
    if (deal.final_price !== undefined && deal.final_price !== null && Number.isFinite(Number(deal.final_price))) {
      return Math.max(0, Math.round(Number(deal.final_price) * 100));
    }
    return 0;
  }

  /**
   * Computes payment settlements (cash vs barter, debt, overpayment) for a single deal
   * as of the end of the selected period (paymentDate <= endDate).
   */
  static computeDealSettlementsAsOf(deal, endDate, barterDeskIds = new Set()) {
    const contractPriceMinor = this.resolveContractPriceMinor(deal);
    const rawPayments = Array.isArray(deal?.payments) ? deal.payments : [];

    let paidCashMinor = 0;
    let paidBarterMinor = 0;
    let totalBarterPaymentRowsOnDeal = 0;

    for (const p of rawPayments) {
      if (isVoidedPayment(p)) continue;

      const isBarter = isBarterPayment(p, barterDeskIds);
      if (isBarter) {
        totalBarterPaymentRowsOnDeal += 1;
      }

      const paymentDate = resolvePaymentDate(p);
      if (paymentDate && paymentDate > endDate) {
        // Payment occurred after the selected reporting period
        continue;
      }

      let amountMinor = 0;
      if (p.amount_minor !== undefined && p.amount_minor !== null && Number.isFinite(Number(p.amount_minor))) {
        amountMinor = Math.round(Number(p.amount_minor));
      } else if (p.amount_usd !== undefined && p.amount_usd !== null && Number.isFinite(Number(p.amount_usd))) {
        amountMinor = Math.round(Number(p.amount_usd) * 100);
      } else if (p.amount_tjs && p.exchange_rate && Number(p.exchange_rate) > 0) {
        amountMinor = Math.round((Number(p.amount_tjs) / Number(p.exchange_rate)) * 100);
      }

      if (amountMinor <= 0) continue;

      if (isBarter) {
        paidBarterMinor += amountMinor;
      } else {
        paidCashMinor += amountMinor;
      }
    }

    // Fallback for deals where barter_amount_minor is stored on the deal record itself
    // without a separate row in public.payments (preventing double counting when payment rows exist)
    const dealBarterMinor = Math.max(0, Math.round(Number(deal?.barter_amount_minor) || 0));
    const contractDate = resolveContractDate(deal);
    if (dealBarterMinor > 0 && totalBarterPaymentRowsOnDeal === 0) {
      if (!contractDate || contractDate <= endDate) {
        paidBarterMinor += dealBarterMinor;
      }
    }

    // Account for any partial/full refund recorded on the deal on or before endDate
    const refundMinor = Math.max(0, Math.round(Number(deal?.refund_amount_minor) || 0));
    if (refundMinor > 0) {
      const refundDate = resolveIsoDate(deal?.refund_date || deal?.cancelled_at) || contractDate;
      if (!refundDate || refundDate <= endDate) {
        if (paidCashMinor >= refundMinor) {
          paidCashMinor -= refundMinor;
        } else {
          const remainder = refundMinor - paidCashMinor;
          paidCashMinor = 0;
          paidBarterMinor = Math.max(0, paidBarterMinor - remainder);
        }
      }
    }

    const totalSettledMinor = paidCashMinor + paidBarterMinor;
    const overpaidMinor = Math.max(0, totalSettledMinor - contractPriceMinor);
    const remainingDebtMinor = Math.max(0, contractPriceMinor - totalSettledMinor);
    const effectivePaidMinor = Math.min(contractPriceMinor, totalSettledMinor);

    const paidPercent = calculatePercent(effectivePaidMinor, contractPriceMinor);
    const debtPercent = calculatePercent(remainingDebtMinor, contractPriceMinor);

    return {
      contractPriceMinor,
      contractPriceUsd: formatMoneyUsd(contractPriceMinor),
      paidCashMinor,
      paidCashUsd: formatMoneyUsd(paidCashMinor),
      paidBarterMinor,
      paidBarterUsd: formatMoneyUsd(paidBarterMinor),
      totalSettledMinor,
      totalSettledUsd: formatMoneyUsd(totalSettledMinor),
      remainingDebtMinor,
      remainingDebtUsd: formatMoneyUsd(remainingDebtMinor),
      overpaidMinor,
      overpaidUsd: formatMoneyUsd(overpaidMinor),
      paidPercent,
      debtPercent
    };
  }

  /**
   * Determines apartment occupancy state at a given boundary date.
   * mode = 'START': state strictly before boundaryDate (i.e. at boundaryDate 00:00:00)
   * mode = 'END': state on or before boundaryDate (i.e. at boundaryDate 23:59:59)
   */
  static evaluateUnitAvailabilityState(unit, unitDeals = [], activeSaleForUnit = null, boundaryDate, mode = 'END') {
    const isBeforeOrOn = (d) => (mode === 'START' ? d < boundaryDate : d <= boundaryDate);
    const isAfter = (d) => (mode === 'START' ? d >= boundaryDate : d > boundaryDate);

    const releaseDate = resolveIsoDate(unit?.available_from || unit?.released_at);
    if (releaseDate && !isBeforeOrOn(releaseDate)) {
      return 'NOT_RELEASED';
    }

    const unitStatus = String(unit?.status || 'AVAILABLE').toUpperCase();
    if (unitStatus === 'BLOCKED') {
      const explicitBlockedAt = resolveIsoDate(unit?.blocked_at);
      if (!explicitBlockedAt || isBeforeOrOn(explicitBlockedAt)) {
        return 'BLOCKED';
      }
    }

    // 1. Check active deduplicated SIGNED contract for this unit
    if (activeSaleForUnit && activeSaleForUnit.contractDate && isBeforeOrOn(activeSaleForUnit.contractDate)) {
      return 'SOLD';
    }

    // 2. Check historical CANCELLED (terminated) contracts that were active at the boundary
    for (const deal of unitDeals) {
      if (!deal) continue;
      const dStatus = String(deal.status || '').toUpperCase();
      const cancelledDate = resolveIsoDate(deal.cancelled_at);

      if (dStatus === 'CANCELLED' || cancelledDate) {
        const dealStart = resolveContractDate(deal);
        if (dealStart && cancelledDate && isBeforeOrOn(dealStart) && isAfter(cancelledDate)) {
          return deal.signed_at || deal.contract_number ? 'SOLD' : 'RESERVED';
        }
      }
    }

    // 3. Check active RESERVED deals
    for (const deal of unitDeals) {
      if (!deal) continue;
      const dStatus = String(deal.status || '').toUpperCase();
      if (dStatus !== 'RESERVED' || deal.cancelled_at) continue;
      if (unitStatus !== 'RESERVED' && unitStatus !== 'SOLD') continue;

      const resStart = resolveIsoDate(deal.reserved_at) || resolveContractDate(deal);
      if (!resStart || !isBeforeOrOn(resStart)) continue;

      return 'RESERVED';
    }

    return 'AVAILABLE';
  }

  /**
   * Pure calculation engine for the Apartment Sales Report V3.
   * Can be called directly in unit tests with custom datasets.
   */
  static computeReport({
    deals = [],
    buildings = [],
    units = [],
    dictionaries = [],
    users = [],
    dealAuditLogs = [],
    marketingPartners = [],
    unitStatusHistory = [],
    query = {},
    now = new Date()
  }) {
    const filters = this.resolveFilters(query, now);

    // Identify barter cash desk IDs and marketing partners from dictionaries / dedicated table
    const barterDeskIds = new Set();
    const partnersMap = new Map();
    const uniquePartnersByName = new Map();

    for (const dict of dictionaries) {
      if (!dict) continue;
      if (dict.type === DICTIONARY_TYPE_PARTNER) {
        const decoded = decodePartnerFromDictionaryRow(dict);
        partnersMap.set(decoded.id, decoded);
        partnersMap.set(String(decoded.id), decoded);
        uniquePartnersByName.set(String(decoded.name || '').trim().toLowerCase(), decoded);
        continue;
      }
      const nameLower = String(dict.name || '').toLowerCase();
      const codeUpper = String(dict.code || '').toUpperCase();
      if (nameLower.includes('бартер') || codeUpper.includes('BARTER')) {
        barterDeskIds.add(String(dict.id));
      }
    }
    barterDeskIds.add('a8ac44fb-8da6-42a8-9243-353202383b58');

    for (const mp of marketingPartners) {
      if (!mp) continue;
      const normalized = mp.commissionRateBp !== undefined ? mp : normalizePartnerFromTableRow(mp);
      partnersMap.set(normalized.id, normalized);
      partnersMap.set(String(normalized.id), normalized);
      if (normalized.legacyDictionaryId) {
        partnersMap.set(String(normalized.legacyDictionaryId), normalized);
      }
      uniquePartnersByName.set(String(normalized.name || '').trim().toLowerCase(), normalized);
    }

    const usersMap = new Map();
    for (const u of users) {
      if (u && u.id !== undefined && u.id !== null) {
        usersMap.set(Number(u.id), u);
      }
    }

    const auditLogsByDealId = new Map();
    for (const log of dealAuditLogs) {
      if (!log || log.deal_id === undefined || log.deal_id === null) continue;
      const dId = Number(log.deal_id);
      if (!auditLogsByDealId.has(dId)) {
        auditLogsByDealId.set(dId, []);
      }
      auditLogsByDealId.get(dId).push(log);
    }

    // 1. Build canonical block definitions enriched with DB IDs if present
    const blockMetaMap = new Map();
    for (const def of CANONICAL_BLOCKS) {
      const key = `${def.projectKey}::${def.blockCode}`;
      blockMetaMap.set(key, {
        key,
        projectId: null,
        projectName: def.projectName,
        rawProjectName: def.projectName,
        buildingId: null,
        blockCode: def.blockCode,
        blockName: def.blockName,
        sortOrder: def.sortOrder
      });
    }

    for (const b of buildings) {
      if (b?.archived_at) continue;
      const projectObj = Array.isArray(b.projects) ? b.projects[0] : b.projects;
      const projectName = normalizeComplexName(projectObj);
      const blockCode = normalizeBlockCode(b);
      if (!projectName || !blockCode) continue;

      const key = `${projectName}::${blockCode}`;
      const existing = blockMetaMap.get(key);
      if (existing) {
        existing.projectId = projectObj?.id ?? b.project_id ?? existing.projectId;
        existing.rawProjectName = projectObj?.name || existing.rawProjectName;
        existing.buildingId = b.id ?? existing.buildingId;
        existing.blockName = b.name || existing.blockName;
      } else {
        blockMetaMap.set(key, {
          key,
          projectId: projectObj?.id ?? b.project_id ?? null,
          projectName,
          rawProjectName: projectObj?.name || projectName,
          buildingId: b.id ?? null,
          blockCode,
          blockName: b.name || `Блок ${blockCode}`,
          sortOrder: 100 + blockMetaMap.size
        });
      }
    }

    // 2. Build unified Apartment units registry (from `units` table + any unit embedded in `deals`)
    const unitsById = new Map();
    for (const u of units) {
      if (!u || u.archived_at) continue;
      const kind = String(u.unit_kind || 'APARTMENT').toUpperCase();
      if (kind !== 'APARTMENT') continue;
      if (u.id !== undefined && u.id !== null) {
        unitsById.set(u.id, u);
      }
    }

    const dealsByUnitId = new Map();
    for (const deal of deals) {
      if (!deal) continue;
      const unit = Array.isArray(deal.units) ? deal.units[0] : deal.units;
      const unitId = deal.unit_id ?? unit?.id;
      if (unitId !== undefined && unitId !== null) {
        if (!dealsByUnitId.has(unitId)) {
          dealsByUnitId.set(unitId, []);
        }
        dealsByUnitId.get(unitId).push(deal);

        if (!unitsById.has(unitId) && unit && !unit.archived_at) {
          const kind = String(unit.unit_kind || 'APARTMENT').toUpperCase();
          if (kind === 'APARTMENT') {
            unitsById.set(unitId, unit);
          }
        }
      }
    }

    // 3. Filter and deduplicate active apartment sales across all deals
    const activeByUnitId = new Map();
    const dataQualityWarnings = [];

    for (const deal of deals) {
      if (!deal) continue;
      const dealStatus = String(deal.status || '').toUpperCase();
      if (dealStatus !== 'SIGNED') continue;
      if (deal.cancelled_at) continue;

      const embeddedUnit = Array.isArray(deal.units) ? deal.units[0] : deal.units;
      const unitId = deal.unit_id ?? embeddedUnit?.id;
      const unit = embeddedUnit || (unitId !== undefined ? unitsById.get(unitId) : null);
      if (!unit || unit.archived_at || !unitId) continue;

      const unitStatus = String(unit.status || 'SOLD').toUpperCase();
      if (unitStatus === 'FREE' || unitStatus === 'CANCELLED' || unitStatus === 'AVAILABLE') {
        continue;
      }

      const unitKind = String(unit.unit_kind || 'APARTMENT').toUpperCase();
      if (unitKind !== 'APARTMENT') continue;

      const contractDate = resolveContractDate(deal);
      if (!contractDate || !DATE_RE.test(contractDate)) continue;

      const hierarchy = extractUnitHierarchy(unit, deal);
      if (!hierarchy.projectName || !hierarchy.blockCode) continue;

      const areaX100 = resolveAreaX100(unit);
      const settlements = this.computeDealSettlementsAsOf(deal, filters.endDate, barterDeskIds);

      // Attribution & Commission resolution (Stage 2, 3, 4)
      const attribution = resolveDealAttributionAndCommission({
        deal: {
          ...deal,
          final_price_minor: settlements.contractPriceMinor,
        },
        auditLogs: auditLogsByDealId.get(Number(deal.id)) || deal.audit_logs || [],
        partnersMap,
        usersMap,
      });

      const leadObj = Array.isArray(deal.leads) ? deal.leads[0] : deal.leads;
      const managerId = deal.responsible_user_id ?? deal.manager_id ?? leadObj?.responsible_user_id ?? deal.created_by ?? null;
      const managerUser = managerId ? usersMap.get(Number(managerId)) : null;
      const managerName = deal.manager_name || managerUser?.name || managerUser?.full_name || 'Не назначен';

      const paymentType = String(deal.payment_type || 'FULL').toUpperCase();
      const declaredDownMinor = Math.max(0, Math.round(Number(deal.down_payment_minor || 0)));
      const paidDownPaymentMinor = Math.min(settlements.totalSettledMinor, declaredDownMinor);
      const paidDownPaymentUsd = formatMoneyUsd(paidDownPaymentMinor);
      const paidDownPaymentPercent = calculatePercent(paidDownPaymentMinor, settlements.contractPriceMinor);
      if (
        (declaredDownMinor > 0 || paymentType === 'PARTIAL_BARTER' || paymentType === 'BARTER') &&
        settlements.paidBarterMinor === 0 &&
        settlements.paidCashMinor === 0
      ) {
        dataQualityWarnings.push({
          dealId: deal.id,
          contractNumber: deal.contract_number || `Договор #${deal.id}`,
          contractDate,
          unitNumber: String(unit.unit_number || ''),
          blockCode: hierarchy.blockCode,
          paymentType,
          declaredDownPaymentUsd: formatMoneyUsd(declaredDownMinor),
          message: `Договор №${deal.contract_number || deal.id} (Блок ${hierarchy.blockCode}, кв. №${unit.unit_number}, тип ${paymentType}): указан первоначальный взнос ${formatMoneyUsd(declaredDownMinor)} USD, но в таблице payments отсутствует проведённый ПКО и barter_amount_minor = 0.`
        });
      }

      const candidate = {
        dealId: deal.id,
        unitId,
        contractDate,
        contractNumber: deal.contract_number || `Договор #${deal.id}`,
        projectId: hierarchy.projectId,
        projectName: hierarchy.projectName,
        rawProjectName: hierarchy.rawProjectName,
        buildingId: hierarchy.buildingId,
        blockCode: hierarchy.blockCode,
        blockName: hierarchy.blockName,
        unitNumber: String(unit.unit_number || ''),
        floorNumber: hierarchy.floorNumber,
        rooms: unit.rooms ?? null,
        areaX100,
        areaM2: formatAreaM2(areaX100),
        status: 'SIGNED',
        statusLabel: 'Действующий',
        paymentType,
        signedAt: deal.signed_at || deal.created_at || '',
        buyerName: leadObj?.full_name || deal.buyer_name || '—',
        managerId: managerId ? Number(managerId) : null,
        managerName,
        salesSource: attribution.salesSource,
        salesSourceLabel: attribution.salesSourceLabel,
        marketingPartnerId: attribution.marketingPartnerId,
        marketingPartnerName: attribution.marketingPartnerName || '—',
        marketerName: attribution.marketerName || '',
        commissionStatus: attribution.commission.status,
        commissionStatusLabel: attribution.commission.statusLabel,
        commissionType: attribution.commission.commissionType,
        commissionRateBp: attribution.commission.commissionRateBp,
        commissionRatePercent: attribution.commission.commissionRatePercent,
        calculatedCommissionMinor: attribution.commission.calculatedCommissionMinor,
        calculatedCommissionUsd: attribution.commission.calculatedCommissionUsd,
        approvedCommissionMinor: attribution.commission.approvedCommissionMinor,
        approvedCommissionUsd: attribution.commission.approvedCommissionUsd,
        paidCommissionMinor: attribution.commission.paidCommissionMinor,
        paidCommissionUsd: attribution.commission.paidCommissionUsd,
        remainingCommissionMinor: attribution.commission.remainingCommissionMinor,
        remainingCommissionUsd: attribution.commission.remainingCommissionUsd,
        commissionAccruedAt: attribution.commission.accruedAt,
        commissionApprovedAt: attribution.commission.approvedAt,
        commissionPaidAt: attribution.commission.paidAt,
        paidDownPaymentMinor,
        paidDownPaymentUsd,
        paidDownPaymentPercent,
        ...settlements
      };

      const prev = activeByUnitId.get(unitId);
      if (!prev) {
        activeByUnitId.set(unitId, candidate);
      } else {
        const prevKey = `${prev.contractDate}::${prev.signedAt}::${String(prev.dealId).padStart(12, '0')}`;
        const nextKey = `${candidate.contractDate}::${candidate.signedAt}::${String(candidate.dealId).padStart(12, '0')}`;
        if (nextKey >= prevKey) {
          activeByUnitId.set(unitId, candidate);
        }
      }
    }

    // 4. Determine which blocks should be displayed according to filters
    const visibleBlockMetas = Array.from(blockMetaMap.values())
      .filter((meta) => {
        if (filters.complex !== 'ALL' && meta.projectName !== filters.complex) return false;
        if (filters.block !== 'ALL' && meta.blockCode !== filters.block) return false;
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const rowsByKey = new Map();
    for (const meta of visibleBlockMetas) {
      rowsByKey.set(meta.key, createEmptyBlockRow(meta));
    }

    // 5. Compute historical apartment inventory counts per block (Start of period vs End of period)
    for (const [unitId, unit] of unitsById.entries()) {
      const hierarchy = extractUnitHierarchy(unit);
      if (!hierarchy.projectName || !hierarchy.blockCode) continue;
      if (filters.complex !== 'ALL' && hierarchy.projectName !== filters.complex) continue;
      if (filters.block !== 'ALL' && hierarchy.blockCode !== filters.block) continue;

      const key = `${hierarchy.projectName}::${hierarchy.blockCode}`;
      let blockRow = rowsByKey.get(key);
      if (!blockRow) {
        blockRow = createEmptyBlockRow({
          key,
          projectId: hierarchy.projectId,
          projectName: hierarchy.projectName,
          rawProjectName: hierarchy.rawProjectName,
          buildingId: hierarchy.buildingId,
          blockCode: hierarchy.blockCode,
          blockName: hierarchy.blockName,
        });
        rowsByKey.set(key, blockRow);
      }

      blockRow.totalApartments += 1;

      const unitDeals = dealsByUnitId.get(unitId) || [];
      const activeSale = activeByUnitId.get(unitId) || null;

      const startState = this.evaluateUnitAvailabilityState(
        unit,
        unitDeals,
        activeSale,
        filters.startDate,
        'START'
      );
      const endState = this.evaluateUnitAvailabilityState(
        unit,
        unitDeals,
        activeSale,
        filters.endDate,
        'END'
      );

      if (endState === 'BLOCKED') {
        blockRow.blockedCount += 1;
      } else if (endState !== 'NOT_RELEASED') {
        blockRow.sellableApartments += 1;
      }

      if (startState === 'AVAILABLE') {
        blockRow.availableStartCount += 1;
      } else if (startState === 'RESERVED') {
        blockRow.reservedStartCount += 1;
      }

      if (endState === 'AVAILABLE') {
        blockRow.availableEndCount += 1;
      } else if (endState === 'RESERVED') {
        blockRow.reservedEndCount += 1;
      }

      const hadCancellationInPeriod = unitDeals.some((d) => {
        const cDate = resolveIsoDate(d?.cancelled_at);
        const sDate = resolveContractDate(d);
        return (
          cDate &&
          cDate >= filters.startDate &&
          cDate <= filters.endDate &&
          (!sDate || sDate <= filters.endDate)
        );
      });
      if (hadCancellationInPeriod) {
        blockRow.cancelledInPeriodCount += 1;
      }
    }

    // 6. Aggregate apartment sales concluded within [startDate, endDate] inclusive
    for (const sale of activeByUnitId.values()) {
      if (sale.contractDate < filters.startDate || sale.contractDate > filters.endDate) {
        continue;
      }
      if (filters.complex !== 'ALL' && sale.projectName !== filters.complex) {
        continue;
      }
      if (filters.block !== 'ALL' && sale.blockCode !== filters.block) {
        continue;
      }
      if (filters.salesSource !== 'ALL' && sale.salesSource !== filters.salesSource) {
        continue;
      }
      if (filters.partnerId !== 'ALL' && String(sale.marketingPartnerId || '') !== String(filters.partnerId)) {
        continue;
      }

      const key = `${sale.projectName}::${sale.blockCode}`;
      let blockRow = rowsByKey.get(key);
      if (!blockRow) {
        blockRow = createEmptyBlockRow({
          key,
          projectId: sale.projectId,
          projectName: sale.projectName,
          rawProjectName: sale.rawProjectName,
          buildingId: sale.buildingId,
          blockCode: sale.blockCode,
          blockName: sale.blockName,
        });
        rowsByKey.set(key, blockRow);
      }

      blockRow.soldCount += 1;
      blockRow.paidDownPaymentMinor += sale.paidDownPaymentMinor;
      if (sale.salesSource === SALES_SOURCES.DIRECT) {
        blockRow.directSoldCount += 1;
        blockRow.directSalesAmountMinor += sale.contractPriceMinor;
        blockRow.directPaidDownPaymentMinor += sale.paidDownPaymentMinor;
      } else if (sale.salesSource === SALES_SOURCES.MARKETER) {
        blockRow.marketerSoldCount += 1;
        blockRow.marketerSalesAmountMinor += sale.contractPriceMinor;
        blockRow.marketerPaidDownPaymentMinor += sale.paidDownPaymentMinor;
      } else {
        blockRow.unspecifiedSoldCount += 1;
        blockRow.unspecifiedSalesAmountMinor += sale.contractPriceMinor;
        blockRow.unspecifiedPaidDownPaymentMinor += sale.paidDownPaymentMinor;
      }

      blockRow.soldAreaX100 += sale.areaX100;
      blockRow.salesAmountMinor += sale.contractPriceMinor;
      blockRow.paidCashMinor += sale.paidCashMinor;
      blockRow.paidBarterMinor += sale.paidBarterMinor;
      blockRow.totalSettledMinor += sale.totalSettledMinor;
      blockRow.remainingDebtMinor += sale.remainingDebtMinor;
      blockRow.overpaidMinor += sale.overpaidMinor;

      blockRow.calculatedCommissionMinor += sale.calculatedCommissionMinor;
      blockRow.approvedCommissionMinor += sale.approvedCommissionMinor;
      blockRow.paidCommissionMinor += sale.paidCommissionMinor;
      blockRow.remainingCommissionMinor += sale.remainingCommissionMinor;

      blockRow.apartments.push({
        dealId: sale.dealId,
        contractDate: sale.contractDate,
        contractNumber: sale.contractNumber,
        projectId: sale.projectId,
        projectName: sale.projectName,
        buildingId: sale.buildingId,
        blockCode: sale.blockCode,
        blockName: sale.blockName,
        unitId: sale.unitId,
        unitNumber: sale.unitNumber,
        floorNumber: sale.floorNumber,
        rooms: sale.rooms,
        areaM2: sale.areaM2,
        status: sale.status,
        statusLabel: sale.statusLabel,
        paymentType: sale.paymentType,
        buyerName: sale.buyerName,
        managerId: sale.managerId,
        managerName: sale.managerName,
        salesSource: sale.salesSource,
        salesSourceLabel: sale.salesSourceLabel,
        marketingPartnerId: sale.marketingPartnerId,
        marketingPartnerName: sale.marketingPartnerName,
        marketerName: sale.marketerName,
        commissionStatus: sale.commissionStatus,
        commissionStatusLabel: sale.commissionStatusLabel,
        commissionType: sale.commissionType,
        commissionRateBp: sale.commissionRateBp,
        commissionRatePercent: sale.commissionRatePercent,
        calculatedCommissionUsd: sale.calculatedCommissionUsd,
        approvedCommissionUsd: sale.approvedCommissionUsd,
        paidCommissionUsd: sale.paidCommissionUsd,
        remainingCommissionUsd: sale.remainingCommissionUsd,
        commissionAccruedAt: sale.commissionAccruedAt,
        commissionApprovedAt: sale.commissionApprovedAt,
        commissionPaidAt: sale.commissionPaidAt,
        contractPriceUsd: sale.contractPriceUsd,
        paidCashUsd: sale.paidCashUsd,
        paidBarterUsd: sale.paidBarterUsd,
        totalSettledUsd: sale.totalSettledUsd,
        remainingDebtUsd: sale.remainingDebtUsd,
        overpaidUsd: sale.overpaidUsd,
        paidPercent: sale.paidPercent,
        debtPercent: sale.debtPercent,
        paidDownPaymentUsd: sale.paidDownPaymentUsd,
        paidDownPaymentPercent: sale.paidDownPaymentPercent
      });
    }

    // 7. Finalize per-block totals and grand totals
    let totalApartments = 0;
    let totalBlockedCount = 0;
    let totalSellableApartments = 0;
    let totalAvailableStartCount = 0;
    let totalReservedStartCount = 0;
    let totalSoldCount = 0;
    let totalDirectSoldCount = 0;
    let totalMarketerSoldCount = 0;
    let totalUnspecifiedSoldCount = 0;
    let totalAvailableEndCount = 0;
    let totalReservedEndCount = 0;
    let totalCancelledInPeriodCount = 0;
    let totalAreaX100 = 0;
    let totalSalesAmountMinor = 0;
    let totalDirectSalesAmountMinor = 0;
    let totalMarketerSalesAmountMinor = 0;
    let totalUnspecifiedSalesAmountMinor = 0;
    let totalPaidDownPaymentMinor = 0;
    let totalDirectPaidDownPaymentMinor = 0;
    let totalMarketerPaidDownPaymentMinor = 0;
    let totalUnspecifiedPaidDownPaymentMinor = 0;
    let totalPaidCashMinor = 0;
    let totalPaidBarterMinor = 0;
    let totalSettledMinor = 0;
    let totalRemainingDebtMinor = 0;
    let totalOverpaidMinor = 0;
    let totalCalculatedCommissionMinor = 0;
    let totalApprovedCommissionMinor = 0;
    let totalPaidCommissionMinor = 0;
    let totalRemainingCommissionMinor = 0;

    const blocks = Array.from(rowsByKey.values()).map((row) => {
      row.apartments.sort((a, b) => {
        if (a.contractDate !== b.contractDate) return a.contractDate.localeCompare(b.contractDate);
        return String(a.unitNumber).localeCompare(String(b.unitNumber), 'ru', { numeric: true });
      });

      row.soldAreaM2 = formatAreaM2(row.soldAreaX100);
      row.salesAmountUsd = formatMoneyUsd(row.salesAmountMinor);
      row.directSalesAmountUsd = formatMoneyUsd(row.directSalesAmountMinor);
      row.marketerSalesAmountUsd = formatMoneyUsd(row.marketerSalesAmountMinor);
      row.unspecifiedSalesAmountUsd = formatMoneyUsd(row.unspecifiedSalesAmountMinor);
      row.paidDownPaymentUsd = formatMoneyUsd(row.paidDownPaymentMinor);
      row.paidDownPaymentPercent = calculatePercent(row.paidDownPaymentMinor, row.salesAmountMinor);
      row.directPaidDownPaymentUsd = formatMoneyUsd(row.directPaidDownPaymentMinor);
      row.directPaidDownPaymentPercent = calculatePercent(row.directPaidDownPaymentMinor, row.directSalesAmountMinor);
      row.marketerPaidDownPaymentUsd = formatMoneyUsd(row.marketerPaidDownPaymentMinor);
      row.marketerPaidDownPaymentPercent = calculatePercent(row.marketerPaidDownPaymentMinor, row.marketerSalesAmountMinor);
      row.unspecifiedPaidDownPaymentUsd = formatMoneyUsd(row.unspecifiedPaidDownPaymentMinor);
      row.unspecifiedPaidDownPaymentPercent = calculatePercent(row.unspecifiedPaidDownPaymentMinor, row.unspecifiedSalesAmountMinor);
      row.sourceBreakdown = [
        {
          salesSource: SALES_SOURCES.DIRECT,
          salesSourceLabel: SALES_SOURCE_LABELS.DIRECT,
          soldCount: row.directSoldCount,
          salesAmountUsd: row.directSalesAmountUsd,
          paidDownPaymentUsd: row.directPaidDownPaymentUsd,
          paidDownPaymentPercent: row.directPaidDownPaymentPercent,
        },
        {
          salesSource: SALES_SOURCES.MARKETER,
          salesSourceLabel: SALES_SOURCE_LABELS.MARKETER,
          soldCount: row.marketerSoldCount,
          salesAmountUsd: row.marketerSalesAmountUsd,
          paidDownPaymentUsd: row.marketerPaidDownPaymentUsd,
          paidDownPaymentPercent: row.marketerPaidDownPaymentPercent,
        },
        {
          salesSource: SALES_SOURCES.UNSPECIFIED,
          salesSourceLabel: SALES_SOURCE_LABELS.UNSPECIFIED,
          soldCount: row.unspecifiedSoldCount,
          salesAmountUsd: row.unspecifiedSalesAmountUsd,
          paidDownPaymentUsd: row.unspecifiedPaidDownPaymentUsd,
          paidDownPaymentPercent: row.unspecifiedPaidDownPaymentPercent,
        },
      ];
      row.paidCashUsd = formatMoneyUsd(row.paidCashMinor);
      row.paidBarterUsd = formatMoneyUsd(row.paidBarterMinor);
      row.totalSettledUsd = formatMoneyUsd(row.totalSettledMinor);
      row.remainingDebtUsd = formatMoneyUsd(row.remainingDebtMinor);
      row.overpaidUsd = formatMoneyUsd(row.overpaidMinor);

      row.calculatedCommissionUsd = formatMoneyUsd(row.calculatedCommissionMinor);
      row.approvedCommissionUsd = formatMoneyUsd(row.approvedCommissionMinor);
      row.paidCommissionUsd = formatMoneyUsd(row.paidCommissionMinor);
      row.remainingCommissionUsd = formatMoneyUsd(row.remainingCommissionMinor);

      const effectiveBlockPaidMinor = Math.max(0, row.totalSettledMinor - row.overpaidMinor);
      row.paidPercent = calculatePercent(effectiveBlockPaidMinor, row.salesAmountMinor);
      row.debtPercent = calculatePercent(row.remainingDebtMinor, row.salesAmountMinor);

      totalApartments += row.totalApartments;
      totalBlockedCount += row.blockedCount;
      totalSellableApartments += row.sellableApartments;
      totalAvailableStartCount += row.availableStartCount;
      totalReservedStartCount += row.reservedStartCount;
      totalSoldCount += row.soldCount;
      totalDirectSoldCount += row.directSoldCount;
      totalMarketerSoldCount += row.marketerSoldCount;
      totalUnspecifiedSoldCount += row.unspecifiedSoldCount;
      totalAvailableEndCount += row.availableEndCount;
      totalReservedEndCount += row.reservedEndCount;
      totalCancelledInPeriodCount += row.cancelledInPeriodCount;
      totalAreaX100 += row.soldAreaX100;
      totalSalesAmountMinor += row.salesAmountMinor;
      totalDirectSalesAmountMinor += row.directSalesAmountMinor;
      totalMarketerSalesAmountMinor += row.marketerSalesAmountMinor;
      totalUnspecifiedSalesAmountMinor += row.unspecifiedSalesAmountMinor;
      totalPaidDownPaymentMinor += row.paidDownPaymentMinor;
      totalDirectPaidDownPaymentMinor += row.directPaidDownPaymentMinor;
      totalMarketerPaidDownPaymentMinor += row.marketerPaidDownPaymentMinor;
      totalUnspecifiedPaidDownPaymentMinor += row.unspecifiedPaidDownPaymentMinor;
      totalPaidCashMinor += row.paidCashMinor;
      totalPaidBarterMinor += row.paidBarterMinor;
      totalSettledMinor += row.totalSettledMinor;
      totalRemainingDebtMinor += row.remainingDebtMinor;
      totalOverpaidMinor += row.overpaidMinor;
      totalCalculatedCommissionMinor += row.calculatedCommissionMinor;
      totalApprovedCommissionMinor += row.approvedCommissionMinor;
      totalPaidCommissionMinor += row.paidCommissionMinor;
      totalRemainingCommissionMinor += row.remainingCommissionMinor;

      const {
        soldAreaX100: _sax,
        salesAmountMinor: _sam,
        directSalesAmountMinor: _dsam,
        marketerSalesAmountMinor: _msam,
        unspecifiedSalesAmountMinor: _usam,
        paidDownPaymentMinor: _pdpm,
        directPaidDownPaymentMinor: _dpdpm,
        marketerPaidDownPaymentMinor: _mpdpm,
        unspecifiedPaidDownPaymentMinor: _updpm,
        paidCashMinor: _pcm,
        paidBarterMinor: _pbm,
        totalSettledMinor: _tsm,
        remainingDebtMinor: _rdm,
        overpaidMinor: _opm,
        calculatedCommissionMinor: _ccm,
        approvedCommissionMinor: _acm,
        paidCommissionMinor: _pacm,
        remainingCommissionMinor: _rcm,
        ...publicRow
      } = row;
      return publicRow;
    });

    const totalAreaM2 = formatAreaM2(totalAreaX100);
    const averageAreaM2 = totalSoldCount > 0
      ? formatAreaM2(Math.round(totalAreaX100 / totalSoldCount))
      : 0;

    const totalSalesAmountUsd = formatMoneyUsd(totalSalesAmountMinor);
    const directSalesAmountUsd = formatMoneyUsd(totalDirectSalesAmountMinor);
    const marketerSalesAmountUsd = formatMoneyUsd(totalMarketerSalesAmountMinor);
    const unspecifiedSalesAmountUsd = formatMoneyUsd(totalUnspecifiedSalesAmountMinor);
    const totalPaidDownPaymentUsd = formatMoneyUsd(totalPaidDownPaymentMinor);
    const totalPaidDownPaymentPercent = calculatePercent(totalPaidDownPaymentMinor, totalSalesAmountMinor);
    const directPaidDownPaymentUsd = formatMoneyUsd(totalDirectPaidDownPaymentMinor);
    const directPaidDownPaymentPercent = calculatePercent(totalDirectPaidDownPaymentMinor, totalDirectSalesAmountMinor);
    const marketerPaidDownPaymentUsd = formatMoneyUsd(totalMarketerPaidDownPaymentMinor);
    const marketerPaidDownPaymentPercent = calculatePercent(totalMarketerPaidDownPaymentMinor, totalMarketerSalesAmountMinor);
    const unspecifiedPaidDownPaymentUsd = formatMoneyUsd(totalUnspecifiedPaidDownPaymentMinor);
    const unspecifiedPaidDownPaymentPercent = calculatePercent(totalUnspecifiedPaidDownPaymentMinor, totalUnspecifiedSalesAmountMinor);
    const totalPaidCashUsd = formatMoneyUsd(totalPaidCashMinor);
    const totalPaidBarterUsd = formatMoneyUsd(totalPaidBarterMinor);
    const totalSettledUsd = formatMoneyUsd(totalSettledMinor);
    const totalRemainingDebtUsd = formatMoneyUsd(totalRemainingDebtMinor);
    const totalOverpaidUsd = formatMoneyUsd(totalOverpaidMinor);

    const calculatedCommissionUsd = formatMoneyUsd(totalCalculatedCommissionMinor);
    const approvedCommissionUsd = formatMoneyUsd(totalApprovedCommissionMinor);
    const paidCommissionUsd = formatMoneyUsd(totalPaidCommissionMinor);
    const remainingCommissionUsd = formatMoneyUsd(totalRemainingCommissionMinor);

    const effectiveTotalPaidMinor = Math.max(0, totalSettledMinor - totalOverpaidMinor);
    const totalPaidPercent = calculatePercent(effectiveTotalPaidMinor, totalSalesAmountMinor);
    const totalDebtPercent = calculatePercent(totalRemainingDebtMinor, totalSalesAmountMinor);

    const allApartments = blocks.flatMap((b) => b.apartments);

    // Build source breakdown (`bySource`) and partner breakdown (`byPartner`)
    const sourceBuckets = {
      [SALES_SOURCES.DIRECT]: {
        salesSource: SALES_SOURCES.DIRECT,
        salesSourceLabel: SALES_SOURCE_LABELS.DIRECT,
        soldCount: 0,
        areaX100: 0,
        salesAmountMinor: 0,
        totalSettledMinor: 0,
        remainingDebtMinor: 0,
        calculatedCommissionMinor: 0,
        approvedCommissionMinor: 0,
        paidCommissionMinor: 0,
        remainingCommissionMinor: 0,
      },
      [SALES_SOURCES.MARKETER]: {
        salesSource: SALES_SOURCES.MARKETER,
        salesSourceLabel: SALES_SOURCE_LABELS.MARKETER,
        soldCount: 0,
        areaX100: 0,
        salesAmountMinor: 0,
        totalSettledMinor: 0,
        remainingDebtMinor: 0,
        calculatedCommissionMinor: 0,
        approvedCommissionMinor: 0,
        paidCommissionMinor: 0,
        remainingCommissionMinor: 0,
      },
      [SALES_SOURCES.UNSPECIFIED]: {
        salesSource: SALES_SOURCES.UNSPECIFIED,
        salesSourceLabel: SALES_SOURCE_LABELS.UNSPECIFIED,
        soldCount: 0,
        areaX100: 0,
        salesAmountMinor: 0,
        totalSettledMinor: 0,
        remainingDebtMinor: 0,
        calculatedCommissionMinor: 0,
        approvedCommissionMinor: 0,
        paidCommissionMinor: 0,
        remainingCommissionMinor: 0,
      },
    };

    const partnerBuckets = new Map();
    for (const partner of partnersMap.values()) {
      partnerBuckets.set(Number(partner.id), {
        partnerId: Number(partner.id),
        partnerName: partner.name,
        contactPerson: partner.contactPerson || '',
        phone: partner.phone || '',
        isActive: partner.isActive,
        commissionType: partner.commissionType,
        commissionRatePercent: partner.commissionRatePercent,
        soldCount: 0,
        areaX100: 0,
        salesAmountMinor: 0,
        totalSettledMinor: 0,
        remainingDebtMinor: 0,
        calculatedCommissionMinor: 0,
        approvedCommissionMinor: 0,
        paidCommissionMinor: 0,
        remainingCommissionMinor: 0,
      });
    }

    for (const apt of allApartments) {
      const bucket = sourceBuckets[apt.salesSource] || sourceBuckets[SALES_SOURCES.UNSPECIFIED];
      bucket.soldCount += 1;
      bucket.areaX100 += Math.round((Number(apt.areaM2) || 0) * 100);
      bucket.salesAmountMinor += Math.round((Number(apt.contractPriceUsd) || 0) * 100);
      bucket.totalSettledMinor += Math.round((Number(apt.totalSettledUsd) || 0) * 100);
      bucket.remainingDebtMinor += Math.round((Number(apt.remainingDebtUsd) || 0) * 100);
      bucket.calculatedCommissionMinor += Math.round((Number(apt.calculatedCommissionUsd) || 0) * 100);
      bucket.approvedCommissionMinor += Math.round((Number(apt.approvedCommissionUsd) || 0) * 100);
      bucket.paidCommissionMinor += Math.round((Number(apt.paidCommissionUsd) || 0) * 100);
      bucket.remainingCommissionMinor += Math.round((Number(apt.remainingCommissionUsd) || 0) * 100);

      if (apt.salesSource === SALES_SOURCES.MARKETER && apt.marketingPartnerId) {
        const pId = Number(apt.marketingPartnerId);
        if (!partnerBuckets.has(pId)) {
          partnerBuckets.set(pId, {
            partnerId: pId,
            partnerName: apt.marketingPartnerName || `Партнёр #${pId}`,
            contactPerson: '',
            phone: '',
            isActive: true,
            commissionType: apt.commissionType || 'NONE',
            commissionRatePercent: apt.commissionRatePercent || 0,
            soldCount: 0,
            areaX100: 0,
            salesAmountMinor: 0,
            totalSettledMinor: 0,
            remainingDebtMinor: 0,
            calculatedCommissionMinor: 0,
            approvedCommissionMinor: 0,
            paidCommissionMinor: 0,
            remainingCommissionMinor: 0,
          });
        }
        const pb = partnerBuckets.get(pId);
        pb.soldCount += 1;
        pb.areaX100 += Math.round((Number(apt.areaM2) || 0) * 100);
        pb.salesAmountMinor += Math.round((Number(apt.contractPriceUsd) || 0) * 100);
        pb.totalSettledMinor += Math.round((Number(apt.totalSettledUsd) || 0) * 100);
        pb.remainingDebtMinor += Math.round((Number(apt.remainingDebtUsd) || 0) * 100);
        pb.calculatedCommissionMinor += Math.round((Number(apt.calculatedCommissionUsd) || 0) * 100);
        pb.approvedCommissionMinor += Math.round((Number(apt.approvedCommissionUsd) || 0) * 100);
        pb.paidCommissionMinor += Math.round((Number(apt.paidCommissionUsd) || 0) * 100);
        pb.remainingCommissionMinor += Math.round((Number(apt.remainingCommissionUsd) || 0) * 100);
      }
    }

    const bySource = Object.values(sourceBuckets).map((b) => ({
      salesSource: b.salesSource,
      salesSourceLabel: b.salesSourceLabel,
      soldCount: b.soldCount,
      shareCountPercent: calculatePercent(b.soldCount, totalSoldCount),
      soldAreaM2: formatAreaM2(b.areaX100),
      salesAmountUsd: formatMoneyUsd(b.salesAmountMinor),
      shareAmountPercent: calculatePercent(b.salesAmountMinor, totalSalesAmountMinor),
      totalSettledUsd: formatMoneyUsd(b.totalSettledMinor),
      remainingDebtUsd: formatMoneyUsd(b.remainingDebtMinor),
      calculatedCommissionUsd: formatMoneyUsd(b.calculatedCommissionMinor),
      approvedCommissionUsd: formatMoneyUsd(b.approvedCommissionMinor),
      paidCommissionUsd: formatMoneyUsd(b.paidCommissionMinor),
      remainingCommissionUsd: formatMoneyUsd(b.remainingCommissionMinor),
    }));

    const byPartner = Array.from(partnerBuckets.values()).map((pb) => ({
      partnerId: pb.partnerId,
      partnerName: pb.partnerName,
      contactPerson: pb.contactPerson,
      phone: pb.phone,
      isActive: pb.isActive,
      commissionType: pb.commissionType,
      commissionRatePercent: pb.commissionRatePercent,
      soldCount: pb.soldCount,
      soldAreaM2: formatAreaM2(pb.areaX100),
      salesAmountUsd: formatMoneyUsd(pb.salesAmountMinor),
      totalSettledUsd: formatMoneyUsd(pb.totalSettledMinor),
      remainingDebtUsd: formatMoneyUsd(pb.remainingDebtMinor),
      calculatedCommissionUsd: formatMoneyUsd(pb.calculatedCommissionMinor),
      approvedCommissionUsd: formatMoneyUsd(pb.approvedCommissionMinor),
      paidCommissionUsd: formatMoneyUsd(pb.paidCommissionMinor),
      remainingCommissionUsd: formatMoneyUsd(pb.remainingCommissionMinor),
    }));

    const hasUnitStatusAuditLog = Array.isArray(unitStatusHistory) && unitStatusHistory.length > 0;

    return {
      generatedAt: new Date(now).toISOString(),
      generatedAtLabel: getDushanbeTimestampLabel(now),
      timezone: 'Asia/Dushanbe',
      filters,
      summary: {
        totalAvailableStartCount,
        totalSoldCount,
        directSoldCount: totalDirectSoldCount,
        marketerSoldCount: totalMarketerSoldCount,
        unspecifiedSoldCount: totalUnspecifiedSoldCount,
        totalAvailableEndCount,
        totalAreaM2,
        averageAreaM2,
        totalSalesAmountUsd,
        directSalesAmountUsd,
        marketerSalesAmountUsd,
        unspecifiedSalesAmountUsd,
        paidDownPaymentUsd: totalPaidDownPaymentUsd,
        paidDownPaymentPercent: totalPaidDownPaymentPercent,
        directPaidDownPaymentUsd,
        directPaidDownPaymentPercent,
        marketerPaidDownPaymentUsd,
        marketerPaidDownPaymentPercent,
        unspecifiedPaidDownPaymentUsd,
        unspecifiedPaidDownPaymentPercent,
        totalPaidCashUsd,
        totalPaidBarterUsd,
        totalSettledUsd,
        totalRemainingDebtUsd,
        totalOverpaidUsd,
        totalPaidPercent,
        totalDebtPercent,
        calculatedCommissionUsd,
        approvedCommissionUsd,
        paidCommissionUsd,
        remainingCommissionUsd,
      },
      blocks,
      totals: {
        totalApartments,
        blockedCount: totalBlockedCount,
        sellableApartments: totalSellableApartments,
        availableStartCount: totalAvailableStartCount,
        reservedStartCount: totalReservedStartCount,
        soldCount: totalSoldCount,
        directSoldCount: totalDirectSoldCount,
        marketerSoldCount: totalMarketerSoldCount,
        unspecifiedSoldCount: totalUnspecifiedSoldCount,
        availableEndCount: totalAvailableEndCount,
        reservedEndCount: totalReservedEndCount,
        cancelledInPeriodCount: totalCancelledInPeriodCount,
        soldAreaM2: totalAreaM2,
        salesAmountUsd: totalSalesAmountUsd,
        directSalesAmountUsd,
        marketerSalesAmountUsd,
        unspecifiedSalesAmountUsd,
        paidDownPaymentUsd: totalPaidDownPaymentUsd,
        paidDownPaymentPercent: totalPaidDownPaymentPercent,
        directPaidDownPaymentUsd,
        directPaidDownPaymentPercent,
        marketerPaidDownPaymentUsd,
        marketerPaidDownPaymentPercent,
        unspecifiedPaidDownPaymentUsd,
        unspecifiedPaidDownPaymentPercent,
        sourceBreakdown: [
          {
            salesSource: SALES_SOURCES.DIRECT,
            salesSourceLabel: SALES_SOURCE_LABELS.DIRECT,
            soldCount: totalDirectSoldCount,
            salesAmountUsd: directSalesAmountUsd,
            paidDownPaymentUsd: directPaidDownPaymentUsd,
            paidDownPaymentPercent: directPaidDownPaymentPercent,
          },
          {
            salesSource: SALES_SOURCES.MARKETER,
            salesSourceLabel: SALES_SOURCE_LABELS.MARKETER,
            soldCount: totalMarketerSoldCount,
            salesAmountUsd: marketerSalesAmountUsd,
            paidDownPaymentUsd: marketerPaidDownPaymentUsd,
            paidDownPaymentPercent: marketerPaidDownPaymentPercent,
          },
          {
            salesSource: SALES_SOURCES.UNSPECIFIED,
            salesSourceLabel: SALES_SOURCE_LABELS.UNSPECIFIED,
            soldCount: totalUnspecifiedSoldCount,
            salesAmountUsd: unspecifiedSalesAmountUsd,
            paidDownPaymentUsd: unspecifiedPaidDownPaymentUsd,
            paidDownPaymentPercent: unspecifiedPaidDownPaymentPercent,
          },
        ],
        paidCashUsd: totalPaidCashUsd,
        paidBarterUsd: totalPaidBarterUsd,
        totalSettledUsd,
        remainingDebtUsd: totalRemainingDebtUsd,
        overpaidUsd: totalOverpaidUsd,
        paidPercent: totalPaidPercent,
        debtPercent: totalDebtPercent,
        calculatedCommissionUsd,
        approvedCommissionUsd,
        paidCommissionUsd,
        remainingCommissionUsd,
      },
      bySource,
      byPartner,
      marketingPartners: Array.from(uniquePartnersByName.values()),
      apartments: allApartments,
      inventoryHistoryMeta: {
        reconstructedFromDeals: !hasUnitStatusAuditLog,
        hasUnitStatusAuditLog,
        note: hasUnitStatusAuditLog
          ? 'Исторический остаток свободных квартир рассчитан с использованием журнала истории статусов квартир (unit_status_history) и дат договоров/расторжений.'
          : 'Исторический остаток свободных квартир рассчитан по фонду продаваемых квартир блока (без заблокированных BLOCKED) за вычетом действующих договоров (SIGNED по deal_date), активных броней (RESERVED) и договоров, находившихся в силе на дату среза до их расторжения (CANCELLED по deal_date и cancelled_at). В БД отсутствует отдельная таблица истории смен статусов квартир (unit_status_history), поэтому ретроспективные даты блокировки/разблокировки (BLOCKED) и бронирований, уже перешедших в продажу, учитываются по текущему состоянию.'
      },
      dataQualityWarnings
    };
  }

  /**
   * Main service entrypoint for GET /api/reports/apartment-sales
   */
  static async getApartmentSalesReport(query = {}, _user = null, db = getSecureDB()) {
    const filters = this.resolveFilters(query);
    const {
      buildings,
      units,
      deals,
      dictionaries,
      users,
      dealAuditLogs,
      marketingPartners,
      unitStatusHistory,
    } = await this.fetchReportDataFromDB(db);

    return this.computeReport({
      deals,
      buildings,
      units,
      dictionaries,
      users,
      dealAuditLogs,
      marketingPartners,
      unitStatusHistory,
      query: filters,
    });
  }

  /**
   * Generates a 4-sheet Excel (.xlsx) workbook for the Apartment Sales Report V3 (Stage 9.5):
   * 1. Сводный отчёт
   * 2. Детализация квартир
   * 3. Источники продаж
   * 4. Комиссии маркетологов
   */
  static async generateExcelWorkbook(query = {}, user = null, db = getSecureDB(), precomputedReport = null) {
    const report = precomputedReport || (await this.getApartmentSalesReport(query, user, db));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TOZON CRM';
    workbook.created = new Date();

    const complexFilterLabel = report.filters.complex === 'ALL' ? 'Все жилые комплексы' : report.filters.complex;
    const blockFilterLabel = report.filters.block === 'ALL' ? 'Все блоки' : `Блок ${report.filters.block}`;
    const sourceFilterLabel = report.filters.salesSource === 'ALL'
      ? 'Все продажи'
      : (SALES_SOURCE_LABELS[report.filters.salesSource] || report.filters.salesSource);
    const periodLabel = `${formatDateRu(report.filters.startDate)} — ${formatDateRu(report.filters.endDate)}`;

    const applyHeaderStyle = (headerRow, rightAlignFromCol = 3, centerCols = [2]) => {
      headerRow.height = 28;
      headerRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: centerCols.includes(colNumber)
            ? 'center'
            : colNumber >= rightAlignFromCol
              ? 'right'
              : 'left',
          wrapText: true
        };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
      });
    };

    const applyDataRowBorders = (row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
    };

    const applyTotalRowStyle = (totalRow, rightAlignFromCol = 3) => {
      totalRow.height = 22;
      totalRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF0F172A' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        cell.alignment = {
          vertical: 'middle',
          horizontal: colNumber >= rightAlignFromCol ? 'right' : 'left'
        };
        cell.border = {
          top: { style: 'medium', color: { argb: 'FF94A3B8' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'double', color: { argb: 'FF475569' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
      });
    };

    // =========================================================================
    // SHEET 1: Сводный отчёт
    // =========================================================================
    const summarySheet = workbook.addWorksheet('Сводный отчёт', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    summarySheet.columns = [
      { key: 'complex', width: 20 },
      { key: 'block', width: 10 },
      { key: 'availableStart', width: 16 },
      { key: 'soldCount', width: 14 },
      { key: 'directSold', width: 14 },
      { key: 'marketerSold', width: 15 },
      { key: 'unspecifiedSold', width: 15 },
      { key: 'availableEnd', width: 16 },
      { key: 'soldArea', width: 16 },
      { key: 'salesAmount', width: 18 },
      { key: 'totalSettled', width: 18 },
      { key: 'paidPercent', width: 13 },
      { key: 'remainingDebt', width: 18 },
      { key: 'debtPercent', width: 13 },
      { key: 'approvedCommission', width: 18 },
      { key: 'remainingCommission', width: 18 },
      { key: 'paidDownPaymentUsd', width: 18 },
      { key: 'paidDownPaymentPercent', width: 13 }
    ];

    const titleRow = summarySheet.addRow(['ОТЧЁТ О ПРОДАЖАХ КВАРТИР И КОМИССИЯХ МАРКЕТОЛОГОВ']);
    summarySheet.mergeCells('A1:R1');
    titleRow.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF0F172A' } };
    titleRow.height = 24;

    summarySheet.addRow(['Выбранный период:', periodLabel, '', 'Дата формирования:', `${report.generatedAtLabel} (Asia/Dushanbe)`]);
    summarySheet.addRow(['Жилой комплекс:', complexFilterLabel, '', 'Блок:', blockFilterLabel, '', 'Источник продажи:', sourceFilterLabel]);
    summarySheet.addRow([]);

    const kpiHeaderRow = summarySheet.addRow(['Сводные показатели за период']);
    summarySheet.mergeCells(`A${kpiHeaderRow.number}:P${kpiHeaderRow.number}`);
    kpiHeaderRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1E293B' } };

    const kpiRows = [
      ['Свободно на начало периода, шт.', report.summary.totalAvailableStartCount, '#,##0', 'Сумма продаж всего, USD', report.summary.totalSalesAmountUsd, '#,##0.00'],
      ['Продано за период всего, шт.', report.summary.totalSoldCount, '#,##0', '   в т.ч. прямые продажи TOZON, USD', report.summary.directSalesAmountUsd, '#,##0.00'],
      ['   в т.ч. продано напрямую (TOZON), шт.', report.summary.directSoldCount, '#,##0', '   в т.ч. продажи через маркетологов, USD', report.summary.marketerSalesAmountUsd, '#,##0.00'],
      ['   в т.ч. через маркетологов, шт.', report.summary.marketerSoldCount, '#,##0', 'Получено всего (на конец периода), USD', report.summary.totalSettledUsd, '#,##0.00'],
      ['   в т.ч. источник не определён, шт.', report.summary.unspecifiedSoldCount, '#,##0', 'Остаток долга покупателей, USD', report.summary.totalRemainingDebtUsd, '#,##0.00'],
      ['Осталось свободных на конец периода, шт.', report.summary.totalAvailableEndCount, '#,##0', 'Начисленная комиссия маркетологам, USD', report.summary.calculatedCommissionUsd, '#,##0.00'],
      ['Проданная площадь, м²', report.summary.totalAreaM2, '#,##0.00', 'Утверждённая комиссия маркетологам, USD', report.summary.approvedCommissionUsd, '#,##0.00'],
      ['Оплачено покупателями, %', report.summary.totalPaidPercent, '0.00"%"', 'Выплаченная комиссия / Остаток к выплате, USD', `${report.summary.paidCommissionUsd} / ${report.summary.remainingCommissionUsd}`, '@']
    ];

    for (const [labelL, valL, fmtL, labelR, valR, fmtR] of kpiRows) {
      const r = summarySheet.addRow([labelL, '', valL, '', labelR, '', valR]);
      r.getCell(3).numFmt = fmtL;
      r.getCell(3).font = { bold: true };
      r.getCell(7).numFmt = fmtR;
      r.getCell(7).font = { bold: true };
    }

    summarySheet.addRow([]);

    const tableHeaderRow = summarySheet.addRow([
      'Жилой комплекс',
      'Блок',
      'Свободно на начало, шт.',
      'Продано за период, шт.',
      'Прямые TOZON, шт.',
      'Через маркетологов, шт.',
      'Источник не опр., шт.',
      'Свободно на конец, шт.',
      'Проданная площадь, м²',
      'Сумма продаж, USD',
      'Получено, USD',
      'Оплачено, %',
      'Остаток долга, USD',
      'Долг, %',
      'Утверждённая комиссия, USD',
      'Остаток комиссии к выплате, USD',
      'Покрытие ПВ (расчётно), USD',
      'Покрытие ПВ, %'
    ]);
    applyHeaderStyle(tableHeaderRow, 3, [2]);

    const addSourceSubrows = (sourceItems, isTotal = false) => {
      for (const item of sourceItems || []) {
        if (item.salesSource === SALES_SOURCES.UNSPECIFIED && (item.soldCount || 0) === 0) {
          continue;
        }
        const subRow = summarySheet.addRow([
          `${isTotal ? 'ИТОГО — ' : '   ↳ '}${item.salesSourceLabel}`,
          '',
          '',
          item.soldCount,
          '',
          '',
          '',
          '',
          '',
          item.salesAmountUsd,
          '',
          '',
          '',
          '',
          '',
          '',
          item.paidDownPaymentUsd,
          item.paidDownPaymentPercent
        ]);
        subRow.height = 18;
        subRow.font = { name: 'Arial', size: 9, italic: !isTotal, bold: isTotal, color: { argb: 'FF475569' } };
        subRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
        subRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
        subRow.getCell(4).numFmt = '#,##0';
        subRow.getCell(10).alignment = { vertical: 'middle', horizontal: 'right' };
        subRow.getCell(10).numFmt = '#,##0.00';
        subRow.getCell(17).alignment = { vertical: 'middle', horizontal: 'right' };
        subRow.getCell(17).numFmt = '#,##0.00';
        subRow.getCell(18).alignment = { vertical: 'middle', horizontal: 'right' };
        subRow.getCell(18).numFmt = '0.00"%"';
        applyDataRowBorders(subRow);
      }
    };

    for (const block of report.blocks) {
      const row = summarySheet.addRow([
        block.projectName,
        block.blockCode,
        block.availableStartCount,
        block.soldCount,
        block.directSoldCount,
        block.marketerSoldCount,
        block.unspecifiedSoldCount,
        block.availableEndCount,
        block.soldAreaM2,
        block.salesAmountUsd,
        block.totalSettledUsd,
        block.paidPercent,
        block.remainingDebtUsd,
        block.debtPercent,
        block.approvedCommissionUsd,
        block.remainingCommissionUsd,
        block.paidDownPaymentUsd,
        block.paidDownPaymentPercent
      ]);
      row.height = 20;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      for (let c = 3; c <= 18; c += 1) {
        row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
      }
      for (const c of [3, 4, 5, 6, 7, 8]) row.getCell(c).numFmt = '#,##0';
      for (const c of [9, 10, 11, 13, 15, 16, 17]) row.getCell(c).numFmt = '#,##0.00';
      row.getCell(12).numFmt = '0.00"%"';
      row.getCell(14).numFmt = '0.00"%"';
      row.getCell(18).numFmt = '0.00"%"';
      applyDataRowBorders(row);
      addSourceSubrows(block.sourceBreakdown, false);
    }

    const totalRow = summarySheet.addRow([
      'ИТОГО',
      '',
      report.totals.availableStartCount,
      report.totals.soldCount,
      report.totals.directSoldCount,
      report.totals.marketerSoldCount,
      report.totals.unspecifiedSoldCount,
      report.totals.availableEndCount,
      report.totals.soldAreaM2,
      report.totals.salesAmountUsd,
      report.totals.totalSettledUsd,
      report.totals.paidPercent,
      report.totals.remainingDebtUsd,
      report.totals.debtPercent,
      report.totals.approvedCommissionUsd,
      report.totals.remainingCommissionUsd,
      report.totals.paidDownPaymentUsd,
      report.totals.paidDownPaymentPercent
    ]);
    applyTotalRowStyle(totalRow, 3);
    for (const c of [3, 4, 5, 6, 7, 8]) totalRow.getCell(c).numFmt = '#,##0';
    for (const c of [9, 10, 11, 13, 15, 16, 17]) totalRow.getCell(c).numFmt = '#,##0.00';
    totalRow.getCell(12).numFmt = '0.00"%"';
    totalRow.getCell(14).numFmt = '0.00"%"';
    totalRow.getCell(18).numFmt = '0.00"%"';
    addSourceSubrows(report.totals.sourceBreakdown, true);

    summarySheet.addRow([]);
    const noteRow = summarySheet.addRow([
      'Примечание: «Покрытие ПВ (расчётно), USD» рассчитывается по каждой сделке как min(подтверждённые платежи деньгами и бартером, договорной ПВ). Показатель является расчётным и не подтверждает целевое назначение каждого отдельного платежа.'
    ]);
    noteRow.font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF64748B' } };

    // =========================================================================
    // SHEET 2: Детализация квартир
    // =========================================================================
    const detailsSheet = workbook.addWorksheet('Детализация квартир', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    detailsSheet.columns = [
      { key: 'index', width: 6 },
      { key: 'contractDate', width: 13 },
      { key: 'contractNumber', width: 15 },
      { key: 'projectName', width: 16 },
      { key: 'blockCode', width: 8 },
      { key: 'unitNumber', width: 10 },
      { key: 'floorNumber', width: 8 },
      { key: 'areaM2', width: 12 },
      { key: 'contractPriceUsd', width: 16 },
      { key: 'paidCashUsd', width: 16 },
      { key: 'paidBarterUsd', width: 15 },
      { key: 'totalSettledUsd', width: 16 },
      { key: 'remainingDebtUsd', width: 16 },
      { key: 'salesSourceLabel', width: 24 },
      { key: 'marketingPartnerName', width: 20 },
      { key: 'managerName', width: 20 },
      { key: 'commissionRatePercent', width: 12 },
      { key: 'calculatedCommissionUsd', width: 15 },
      { key: 'approvedCommissionUsd', width: 15 },
      { key: 'paidCommissionUsd', width: 15 },
      { key: 'remainingCommissionUsd', width: 15 }
    ];

    const detailTitle = detailsSheet.addRow([
      `ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР (${periodLabel})`
    ]);
    detailsSheet.mergeCells('A1:U1');
    detailTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    detailTitle.height = 24;

    detailsSheet.addRow([
      'Фильтры:',
      `ЖК: ${complexFilterLabel}; Блок: ${blockFilterLabel}; Источник: ${sourceFilterLabel}`,
      '',
      '',
      'Сформировано:',
      `${report.generatedAtLabel} (Asia/Dushanbe)`
    ]);
    detailsSheet.addRow([]);

    const detailHeader = detailsSheet.addRow([
      '№',
      'Дата договора',
      'Номер договора',
      'Жилой комплекс',
      'Блок',
      'Квартира',
      'Этаж',
      'Площадь, м²',
      'Договорная стоимость, USD',
      'Получено деньгами, USD',
      'Зачтено бартером, USD',
      'Всего погашено, USD',
      'Остаток долга, USD',
      'Источник продажи',
      'Маркетинговый партнёр',
      'Ответственный менеджер TOZON',
      'Ставка комиссии, %',
      'Начисленная комиссия, USD',
      'Утверждённая комиссия, USD',
      'Выплаченная комиссия, USD',
      'Остаток комиссии, USD'
    ]);
    applyHeaderStyle(detailHeader, 8, [1, 2, 5, 6, 7]);
    for (const c of [14, 15, 16]) {
      detailHeader.getCell(c).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    }

    report.apartments.forEach((apt, idx) => {
      const row = detailsSheet.addRow([
        idx + 1,
        formatDateRu(apt.contractDate),
        apt.contractNumber,
        apt.projectName,
        apt.blockCode,
        apt.unitNumber,
        apt.floorNumber ?? '—',
        apt.areaM2,
        apt.contractPriceUsd,
        apt.paidCashUsd,
        apt.paidBarterUsd,
        apt.totalSettledUsd,
        apt.remainingDebtUsd,
        apt.salesSourceLabel,
        apt.marketingPartnerName || '—',
        apt.managerName || '—',
        apt.commissionRatePercent || 0,
        apt.calculatedCommissionUsd || 0,
        apt.approvedCommissionUsd || 0,
        apt.paidCommissionUsd || 0,
        apt.remainingCommissionUsd || 0
      ]);
      row.height = 19;
      for (const c of [1, 2, 5, 6, 7]) row.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
      for (const c of [3, 4, 14, 15, 16]) row.getCell(c).alignment = { vertical: 'middle', horizontal: 'left' };
      for (const c of [8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21]) {
        row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
      }
      for (const c of [8, 9, 10, 11, 12, 13, 18, 19, 20, 21]) row.getCell(c).numFmt = '#,##0.00';
      row.getCell(17).numFmt = '0.00"%"';
      applyDataRowBorders(row);
    });

    const detailTotalRow = detailsSheet.addRow([
      'ИТОГО',
      '',
      `Квартир: ${report.totals.soldCount} шт.`,
      '',
      '',
      '',
      '',
      report.totals.soldAreaM2,
      report.totals.salesAmountUsd,
      report.totals.paidCashUsd,
      report.totals.paidBarterUsd,
      report.totals.totalSettledUsd,
      report.totals.remainingDebtUsd,
      `Прямых: ${report.totals.directSoldCount} | Маркетол.: ${report.totals.marketerSoldCount} | Не опр.: ${report.totals.unspecifiedSoldCount}`,
      '',
      '',
      '',
      report.totals.calculatedCommissionUsd,
      report.totals.approvedCommissionUsd,
      report.totals.paidCommissionUsd,
      report.totals.remainingCommissionUsd
    ]);
    applyTotalRowStyle(detailTotalRow, 8);
    detailTotalRow.getCell(14).alignment = { vertical: 'middle', horizontal: 'left' };
    for (const c of [8, 9, 10, 11, 12, 13, 18, 19, 20, 21]) detailTotalRow.getCell(c).numFmt = '#,##0.00';

    // =========================================================================
    // SHEET 3: Источники продаж
    // =========================================================================
    const sourcesSheet = workbook.addWorksheet('Источники продаж', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    sourcesSheet.columns = [
      { key: 'channel', width: 28 },
      { key: 'soldCount', width: 16 },
      { key: 'shareCount', width: 14 },
      { key: 'soldArea', width: 16 },
      { key: 'salesAmount', width: 18 },
      { key: 'shareAmount', width: 14 },
      { key: 'totalSettled', width: 18 },
      { key: 'remainingDebt', width: 18 },
      { key: 'calculatedCommission', width: 18 },
      { key: 'approvedCommission', width: 18 },
      { key: 'paidCommission', width: 18 },
      { key: 'remainingCommission', width: 18 }
    ];

    const sourcesTitle = sourcesSheet.addRow([`АНАЛИТИКА ПО ИСТОЧНИКАМ ПРОДАЖ (${periodLabel})`]);
    sourcesSheet.mergeCells('A1:L1');
    sourcesTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    sourcesTitle.height = 24;
    sourcesSheet.addRow([]);

    const sourcesHeader = sourcesSheet.addRow([
      'Канал / Источник продажи',
      'Продано квартир, шт.',
      'Доля в шт., %',
      'Проданная площадь, м²',
      'Сумма продаж, USD',
      'Доля в сумме, %',
      'Получено оплат, USD',
      'Остаток долга, USD',
      'Начисленная комиссия, USD',
      'Утверждённая комиссия, USD',
      'Выплаченная комиссия, USD',
      'Остаток комиссии к выплате, USD'
    ]);
    applyHeaderStyle(sourcesHeader, 2, []);

    for (const src of report.bySource) {
      const row = sourcesSheet.addRow([
        src.salesSourceLabel,
        src.soldCount,
        src.shareCountPercent,
        src.soldAreaM2,
        src.salesAmountUsd,
        src.shareAmountPercent,
        src.totalSettledUsd,
        src.remainingDebtUsd,
        src.calculatedCommissionUsd,
        src.approvedCommissionUsd,
        src.paidCommissionUsd,
        src.remainingCommissionUsd
      ]);
      row.height = 20;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      for (let c = 2; c <= 12; c += 1) row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
      row.getCell(2).numFmt = '#,##0';
      row.getCell(3).numFmt = '0.00"%"';
      row.getCell(6).numFmt = '0.00"%"';
      for (const c of [4, 5, 7, 8, 9, 10, 11, 12]) row.getCell(c).numFmt = '#,##0.00';
      applyDataRowBorders(row);
    }

    const sourcesTotalRow = sourcesSheet.addRow([
      'ИТОГО',
      report.totals.soldCount,
      report.totals.soldCount > 0 ? 100 : 0,
      report.totals.soldAreaM2,
      report.totals.salesAmountUsd,
      report.totals.salesAmountUsd > 0 ? 100 : 0,
      report.totals.totalSettledUsd,
      report.totals.remainingDebtUsd,
      report.totals.calculatedCommissionUsd,
      report.totals.approvedCommissionUsd,
      report.totals.paidCommissionUsd,
      report.totals.remainingCommissionUsd
    ]);
    applyTotalRowStyle(sourcesTotalRow, 2);
    sourcesTotalRow.getCell(2).numFmt = '#,##0';
    sourcesTotalRow.getCell(3).numFmt = '0.00"%"';
    sourcesTotalRow.getCell(6).numFmt = '0.00"%"';
    for (const c of [4, 5, 7, 8, 9, 10, 11, 12]) sourcesTotalRow.getCell(c).numFmt = '#,##0.00';

    // =========================================================================
    // SHEET 4: Комиссии маркетологов
    // =========================================================================
    const commissionsSheet = workbook.addWorksheet('Комиссии маркетологов', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    commissionsSheet.columns = [
      { key: 'partnerName', width: 24 },
      { key: 'contractNumber', width: 16 },
      { key: 'contractDate', width: 14 },
      { key: 'blockUnit', width: 16 },
      { key: 'salesSourceLabel', width: 22 },
      { key: 'contractPriceUsd', width: 18 },
      { key: 'commissionRatePercent', width: 14 },
      { key: 'calculatedCommissionUsd', width: 18 },
      { key: 'approvedCommissionUsd', width: 18 },
      { key: 'paidCommissionUsd', width: 18 },
      { key: 'remainingCommissionUsd', width: 18 },
      { key: 'commissionStatusLabel', width: 20 }
    ];

    const commTitle = commissionsSheet.addRow([`КОНТРОЛЬ КОМИССИЙ МАРКЕТОЛОГОВ (${periodLabel})`]);
    commissionsSheet.mergeCells('A1:L1');
    commTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    commTitle.height = 24;
    commissionsSheet.addRow([]);

    // Section A: Partner Summary
    const partnerSubHeader = commissionsSheet.addRow(['1. Сводка по маркетинговым партнёрам']);
    partnerSubHeader.font = { name: 'Arial', size: 11, bold: true };

    const partnerHeaderRow = commissionsSheet.addRow([
      'Маркетинговый партнёр',
      'Контактное лицо / Телефон',
      'Базовая ставка, %',
      'Продано квартир, шт.',
      'Проданная площадь, м²',
      'Сумма договоров, USD',
      'Получено от клиентов, USD',
      'Начисленная комиссия, USD',
      'Утверждённая комиссия, USD',
      'Выплаченная комиссия, USD',
      'Остаток к выплате, USD',
      'Статус партнёра'
    ]);
    applyHeaderStyle(partnerHeaderRow, 3, [12]);

    for (const pb of report.byPartner) {
      const r = commissionsSheet.addRow([
        pb.partnerName,
        [pb.contactPerson, pb.phone].filter(Boolean).join(' / ') || '—',
        pb.commissionRatePercent || 0,
        pb.soldCount,
        pb.soldAreaM2,
        pb.salesAmountUsd,
        pb.totalSettledUsd,
        pb.calculatedCommissionUsd,
        pb.approvedCommissionUsd,
        pb.paidCommissionUsd,
        pb.remainingCommissionUsd,
        pb.isActive ? 'Активен' : 'Неактивен'
      ]);
      r.height = 19;
      r.getCell(3).numFmt = '0.00"%"';
      r.getCell(4).numFmt = '#,##0';
      for (const c of [5, 6, 7, 8, 9, 10, 11]) r.getCell(c).numFmt = '#,##0.00';
      applyDataRowBorders(r);
    }

    commissionsSheet.addRow([]);

    // Section B: Deal-by-Deal Commission Registry
    const dealCommSubHeader = commissionsSheet.addRow(['2. Реестр договоров и начислений комиссий']);
    dealCommSubHeader.font = { name: 'Arial', size: 11, bold: true };

    const commDealsHeader = commissionsSheet.addRow([
      'Маркетинговый партнёр',
      'Номер договора',
      'Дата договора',
      'Блок / Квартира',
      'Источник продажи',
      'Стоимость договора, USD',
      'Ставка комиссии, %',
      'Начислено, USD',
      'Утверждено, USD',
      'Выплачено, USD',
      'Остаток к выплате, USD',
      'Статус комиссии'
    ]);
    applyHeaderStyle(commDealsHeader, 6, [3, 4, 12]);

    for (const apt of report.apartments) {
      const r = commissionsSheet.addRow([
        apt.marketingPartnerName || '—',
        apt.contractNumber,
        formatDateRu(apt.contractDate),
        `Блок ${apt.blockCode}, кв. ${apt.unitNumber}`,
        apt.salesSourceLabel,
        apt.contractPriceUsd,
        apt.commissionRatePercent || 0,
        apt.calculatedCommissionUsd || 0,
        apt.approvedCommissionUsd || 0,
        apt.paidCommissionUsd || 0,
        apt.remainingCommissionUsd || 0,
        apt.commissionStatusLabel
      ]);
      r.height = 19;
      for (const c of [6, 8, 9, 10, 11]) r.getCell(c).numFmt = '#,##0.00';
      r.getCell(7).numFmt = '0.00"%"';
      applyDataRowBorders(r);
    }

    const commTotalRow = commissionsSheet.addRow([
      'ИТОГО ПО ОТЧЁТУ',
      `Договоров: ${report.totals.soldCount}`,
      '',
      '',
      '',
      report.totals.salesAmountUsd,
      '',
      report.totals.calculatedCommissionUsd,
      report.totals.approvedCommissionUsd,
      report.totals.paidCommissionUsd,
      report.totals.remainingCommissionUsd,
      ''
    ]);
    applyTotalRowStyle(commTotalRow, 6);
    for (const c of [6, 8, 9, 10, 11]) commTotalRow.getCell(c).numFmt = '#,##0.00';

    return workbook.xlsx.writeBuffer();
  }
}
