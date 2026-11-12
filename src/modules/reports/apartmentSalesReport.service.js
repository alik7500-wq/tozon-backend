import ExcelJS from 'exceljs';
import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';

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

    return {
      startDate,
      endDate,
      complex,
      block
    };
  }

  /**
   * Fetches buildings, apartments inventory, all deals with payments, and cash desk dictionaries from Supabase.
   */
  static async fetchReportDataFromDB(db = getSecureDB()) {
    const [buildingsRes, unitsRes, dealsRes, dictsRes] = await Promise.all([
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
        .select('id, type, code, name')
        .eq('type', 'CASH_DESK')
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

    return {
      buildings: buildingsRes.data || [],
      units: unitsRes.data || [],
      deals: dealsRes.data || [],
      dictionaries: dictsRes?.data || []
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
   *
   * Returns:
   * - 'BLOCKED': apartment is blocked / held by developer and not available for sale
   * - 'NOT_RELEASED': apartment has an explicit available_from / released_at date after the boundary
   * - 'SOLD': apartment has an active contract as of the boundary
   * - 'RESERVED': apartment has an active reservation as of the boundary
   * - 'AVAILABLE': apartment is available for sale as of the boundary
   */
  static evaluateUnitAvailabilityState(unit, unitDeals = [], activeSaleForUnit = null, boundaryDate, mode = 'END') {
    const isBeforeOrOn = (d) => (mode === 'START' ? d < boundaryDate : d <= boundaryDate);
    const isAfter = (d) => (mode === 'START' ? d >= boundaryDate : d > boundaryDate);

    // Optional explicit release date (if present in unit metadata/tests)
    const releaseDate = resolveIsoDate(unit?.available_from || unit?.released_at);
    if (releaseDate && !isBeforeOrOn(releaseDate)) {
      return 'NOT_RELEASED';
    }

    // Blocked status check (with optional blocked_at support)
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
          // If the deal had been signed before termination, it was SOLD at that point; otherwise RESERVED
          return deal.signed_at || deal.contract_number ? 'SOLD' : 'RESERVED';
        }
      }
    }

    // 3. Check active RESERVED deals (in TOZON CRM an active reservation holds the apartment until explicitly cancelled or converted to SIGNED)
    for (const deal of unitDeals) {
      if (!deal) continue;
      const dStatus = String(deal.status || '').toUpperCase();
      if (dStatus !== 'RESERVED' || deal.cancelled_at) continue;
      if (unitStatus !== 'RESERVED' && unitStatus !== 'SOLD') continue;

      const resStart = resolveContractDate(deal);
      if (!resStart || !isBeforeOrOn(resStart)) continue;

      return 'RESERVED';
    }

    return 'AVAILABLE';
  }

  /**
   * Pure calculation engine for the Apartment Sales Report.
   * Can be called directly in unit tests with custom datasets.
   */
  static computeReport({
    deals = [],
    buildings = [],
    units = [],
    dictionaries = [],
    query = {},
    now = new Date()
  }) {
    const filters = this.resolveFilters(query, now);

    // Identify barter cash desk IDs from dictionaries
    const barterDeskIds = new Set();
    for (const dict of dictionaries) {
      if (!dict) continue;
      const nameLower = String(dict.name || '').toLowerCase();
      const codeUpper = String(dict.code || '').toUpperCase();
      if (nameLower.includes('бартер') || codeUpper.includes('BARTER')) {
        barterDeskIds.add(String(dict.id));
      }
    }
    // Always include the canonical production Barter Cash Desk ID as a safeguard
    barterDeskIds.add('a8ac44fb-8da6-42a8-9243-353202383b58');

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
    // Rules:
    // - Deal status must be 'SIGNED' and cancelled_at must be null
    // - Unit must exist, not be archived, and not be in 'FREE' / 'CANCELLED' / 'AVAILABLE' status
    // - Unit kind must be 'APARTMENT' (exclude 'COMMERCIAL' and 'PARKING')
    // - Deduplicate by unit_id: each apartment is counted at most once (latest active contract wins)
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

      // Exclude apartments whose unit status was reverted to FREE/AVAILABLE due to contract termination
      const unitStatus = String(unit.status || 'SOLD').toUpperCase();
      if (unitStatus === 'FREE' || unitStatus === 'CANCELLED' || unitStatus === 'AVAILABLE') {
        continue;
      }

      // Only APARTMENT (exclude COMMERCIAL and PARKING)
      const unitKind = String(unit.unit_kind || 'APARTMENT').toUpperCase();
      if (unitKind !== 'APARTMENT') continue;

      const contractDate = resolveContractDate(deal);
      if (!contractDate || !DATE_RE.test(contractDate)) continue;

      const hierarchy = extractUnitHierarchy(unit, deal);
      if (!hierarchy.projectName || !hierarchy.blockCode) continue;

      const areaX100 = resolveAreaX100(unit);
      const settlements = this.computeDealSettlementsAsOf(deal, filters.endDate, barterDeskIds);

      // Flag deals that declare PARTIAL_BARTER or down_payment_minor > 0 but have 0 confirmed payments/barter
      const paymentType = String(deal.payment_type || 'FULL').toUpperCase();
      if (
        (paymentType === 'PARTIAL_BARTER' || paymentType === 'BARTER') &&
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
          declaredDownPaymentUsd: formatMoneyUsd(deal.down_payment_minor || 0),
          message: `Договор №${deal.contract_number || deal.id} (кв. №${unit.unit_number}) имеет тип ${paymentType}, но в таблице payments отсутствует проведённый ПКО и barter_amount_minor = 0.`
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
      rowsByKey.set(meta.key, {
        key: meta.key,
        projectId: meta.projectId,
        projectName: meta.projectName,
        rawProjectName: meta.rawProjectName,
        buildingId: meta.buildingId,
        blockCode: meta.blockCode,
        blockName: meta.blockName,
        totalApartments: 0,
        blockedCount: 0,
        sellableApartments: 0,
        availableStartCount: 0,
        reservedStartCount: 0,
        soldCount: 0,
        availableEndCount: 0,
        reservedEndCount: 0,
        cancelledInPeriodCount: 0,
        soldAreaX100: 0,
        soldAreaM2: 0,
        salesAmountMinor: 0,
        salesAmountUsd: 0,
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
        apartments: []
      });
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
        blockRow = {
          key,
          projectId: hierarchy.projectId,
          projectName: hierarchy.projectName,
          rawProjectName: hierarchy.rawProjectName,
          buildingId: hierarchy.buildingId,
          blockCode: hierarchy.blockCode,
          blockName: hierarchy.blockName,
          totalApartments: 0,
          blockedCount: 0,
          sellableApartments: 0,
          availableStartCount: 0,
          reservedStartCount: 0,
          soldCount: 0,
          availableEndCount: 0,
          reservedEndCount: 0,
          cancelledInPeriodCount: 0,
          soldAreaX100: 0,
          soldAreaM2: 0,
          salesAmountMinor: 0,
          salesAmountUsd: 0,
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
          apartments: []
        };
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

      // Count contracts terminated during the selected period [startDate, endDate]
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

      const key = `${sale.projectName}::${sale.blockCode}`;
      let blockRow = rowsByKey.get(key);
      if (!blockRow) {
        blockRow = {
          key,
          projectId: sale.projectId,
          projectName: sale.projectName,
          rawProjectName: sale.rawProjectName,
          buildingId: sale.buildingId,
          blockCode: sale.blockCode,
          blockName: sale.blockName,
          totalApartments: 0,
          blockedCount: 0,
          sellableApartments: 0,
          availableStartCount: 0,
          reservedStartCount: 0,
          soldCount: 0,
          availableEndCount: 0,
          reservedEndCount: 0,
          cancelledInPeriodCount: 0,
          soldAreaX100: 0,
          soldAreaM2: 0,
          salesAmountMinor: 0,
          salesAmountUsd: 0,
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
          apartments: []
        };
        rowsByKey.set(key, blockRow);
      }

      blockRow.soldCount += 1;
      blockRow.soldAreaX100 += sale.areaX100;
      blockRow.salesAmountMinor += sale.contractPriceMinor;
      blockRow.paidCashMinor += sale.paidCashMinor;
      blockRow.paidBarterMinor += sale.paidBarterMinor;
      blockRow.totalSettledMinor += sale.totalSettledMinor;
      blockRow.remainingDebtMinor += sale.remainingDebtMinor;
      blockRow.overpaidMinor += sale.overpaidMinor;

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
        contractPriceUsd: sale.contractPriceUsd,
        paidCashUsd: sale.paidCashUsd,
        paidBarterUsd: sale.paidBarterUsd,
        totalSettledUsd: sale.totalSettledUsd,
        remainingDebtUsd: sale.remainingDebtUsd,
        overpaidUsd: sale.overpaidUsd,
        paidPercent: sale.paidPercent,
        debtPercent: sale.debtPercent
      });
    }

    // 7. Finalize per-block totals and grand totals
    let totalApartments = 0;
    let totalBlockedCount = 0;
    let totalSellableApartments = 0;
    let totalAvailableStartCount = 0;
    let totalReservedStartCount = 0;
    let totalSoldCount = 0;
    let totalAvailableEndCount = 0;
    let totalReservedEndCount = 0;
    let totalCancelledInPeriodCount = 0;
    let totalAreaX100 = 0;
    let totalSalesAmountMinor = 0;
    let totalPaidCashMinor = 0;
    let totalPaidBarterMinor = 0;
    let totalSettledMinor = 0;
    let totalRemainingDebtMinor = 0;
    let totalOverpaidMinor = 0;

    const blocks = Array.from(rowsByKey.values()).map((row) => {
      row.apartments.sort((a, b) => {
        if (a.contractDate !== b.contractDate) return a.contractDate.localeCompare(b.contractDate);
        return String(a.unitNumber).localeCompare(String(b.unitNumber), 'ru', { numeric: true });
      });

      row.soldAreaM2 = formatAreaM2(row.soldAreaX100);
      row.salesAmountUsd = formatMoneyUsd(row.salesAmountMinor);
      row.paidCashUsd = formatMoneyUsd(row.paidCashMinor);
      row.paidBarterUsd = formatMoneyUsd(row.paidBarterMinor);
      row.totalSettledUsd = formatMoneyUsd(row.totalSettledMinor);
      row.remainingDebtUsd = formatMoneyUsd(row.remainingDebtMinor);
      row.overpaidUsd = formatMoneyUsd(row.overpaidMinor);

      const effectiveBlockPaidMinor = Math.max(0, row.totalSettledMinor - row.overpaidMinor);
      row.paidPercent = calculatePercent(effectiveBlockPaidMinor, row.salesAmountMinor);
      row.debtPercent = calculatePercent(row.remainingDebtMinor, row.salesAmountMinor);

      totalApartments += row.totalApartments;
      totalBlockedCount += row.blockedCount;
      totalSellableApartments += row.sellableApartments;
      totalAvailableStartCount += row.availableStartCount;
      totalReservedStartCount += row.reservedStartCount;
      totalSoldCount += row.soldCount;
      totalAvailableEndCount += row.availableEndCount;
      totalReservedEndCount += row.reservedEndCount;
      totalCancelledInPeriodCount += row.cancelledInPeriodCount;
      totalAreaX100 += row.soldAreaX100;
      totalSalesAmountMinor += row.salesAmountMinor;
      totalPaidCashMinor += row.paidCashMinor;
      totalPaidBarterMinor += row.paidBarterMinor;
      totalSettledMinor += row.totalSettledMinor;
      totalRemainingDebtMinor += row.remainingDebtMinor;
      totalOverpaidMinor += row.overpaidMinor;

      const {
        soldAreaX100,
        salesAmountMinor,
        paidCashMinor,
        paidBarterMinor,
        totalSettledMinor: _tsm,
        remainingDebtMinor: _rdm,
        overpaidMinor: _opm,
        ...publicRow
      } = row;
      return publicRow;
    });

    const totalAreaM2 = formatAreaM2(totalAreaX100);
    const averageAreaM2 = totalSoldCount > 0
      ? formatAreaM2(Math.round(totalAreaX100 / totalSoldCount))
      : 0;

    const totalSalesAmountUsd = formatMoneyUsd(totalSalesAmountMinor);
    const totalPaidCashUsd = formatMoneyUsd(totalPaidCashMinor);
    const totalPaidBarterUsd = formatMoneyUsd(totalPaidBarterMinor);
    const totalSettledUsd = formatMoneyUsd(totalSettledMinor);
    const totalRemainingDebtUsd = formatMoneyUsd(totalRemainingDebtMinor);
    const totalOverpaidUsd = formatMoneyUsd(totalOverpaidMinor);

    const effectiveTotalPaidMinor = Math.max(0, totalSettledMinor - totalOverpaidMinor);
    const totalPaidPercent = calculatePercent(effectiveTotalPaidMinor, totalSalesAmountMinor);
    const totalDebtPercent = calculatePercent(totalRemainingDebtMinor, totalSalesAmountMinor);

    const allApartments = blocks.flatMap((b) => b.apartments);

    return {
      generatedAt: new Date(now).toISOString(),
      generatedAtLabel: getDushanbeTimestampLabel(now),
      timezone: 'Asia/Dushanbe',
      filters,
      summary: {
        totalAvailableStartCount,
        totalSoldCount,
        totalAvailableEndCount,
        totalAreaM2,
        averageAreaM2,
        totalSalesAmountUsd,
        totalPaidCashUsd,
        totalPaidBarterUsd,
        totalSettledUsd,
        totalRemainingDebtUsd,
        totalOverpaidUsd,
        totalPaidPercent,
        totalDebtPercent
      },
      blocks,
      totals: {
        totalApartments,
        blockedCount: totalBlockedCount,
        sellableApartments: totalSellableApartments,
        availableStartCount: totalAvailableStartCount,
        reservedStartCount: totalReservedStartCount,
        soldCount: totalSoldCount,
        availableEndCount: totalAvailableEndCount,
        reservedEndCount: totalReservedEndCount,
        cancelledInPeriodCount: totalCancelledInPeriodCount,
        soldAreaM2: totalAreaM2,
        salesAmountUsd: totalSalesAmountUsd,
        paidCashUsd: totalPaidCashUsd,
        paidBarterUsd: totalPaidBarterUsd,
        totalSettledUsd,
        remainingDebtUsd: totalRemainingDebtUsd,
        overpaidUsd: totalOverpaidUsd,
        paidPercent: totalPaidPercent,
        debtPercent: totalDebtPercent
      },
      apartments: allApartments,
      inventoryHistoryMeta: {
        reconstructedFromDeals: true,
        hasUnitStatusAuditLog: false,
        note: 'Исторический остаток свободных квартир рассчитан по фонду продаваемых квартир блока (без заблокированных BLOCKED) за вычетом действующих договоров (SIGNED po deal_date), активных броней (RESERVED) и договоров, находившихся в силе на дату среза до их расторжения (CANCELLED по deal_date и cancelled_at). В БД отсутствует отдельная таблица истории смен статусов квартир (unit_status_history), поэтому ретроспективные даты блокировки/разблокировки (BLOCKED) и бронирований, уже перешедших в продажу, учитываются по текущему состоянию.'
      },
      dataQualityWarnings
    };
  }

  /**
   * Main service entrypoint for GET /api/reports/apartment-sales
   */
  static async getApartmentSalesReport(query = {}, _user = null, db = getSecureDB()) {
    const filters = this.resolveFilters(query);
    const { buildings, units, deals, dictionaries } = await this.fetchReportDataFromDB(db);
    return this.computeReport({ deals, buildings, units, dictionaries, query: filters });
  }

  /**
   * Generates a 2-sheet Excel (.xlsx) workbook for the Apartment Sales Report.
   * Sheet 1: Сводный отчёт (Landscape A4, Summary KPIs + 11-column Block Table + ИТОГО)
   * Sheet 2: Детализация квартир (Landscape A4, Full list of sold apartments with financial metrics + ИТОГО)
   */
  static async generateExcelWorkbook(query = {}, user = null, db = getSecureDB(), precomputedReport = null) {
    const report = precomputedReport || (await this.getApartmentSalesReport(query, user, db));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TOZON CRM';
    workbook.created = new Date();

    const complexFilterLabel = report.filters.complex === 'ALL' ? 'Все жилые комплексы' : report.filters.complex;
    const blockFilterLabel = report.filters.block === 'ALL' ? 'Все блоки' : `Блок ${report.filters.block}`;
    const periodLabel = `${formatDateRu(report.filters.startDate)} — ${formatDateRu(report.filters.endDate)}`;

    // =========================================================================
    // SHEET 1: Сводный отчёт
    // =========================================================================
    const summarySheet = workbook.addWorksheet('Сводный отчёт', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    summarySheet.columns = [
      { key: 'complex', width: 20 },
      { key: 'block', width: 10 },
      { key: 'availableStart', width: 18 },
      { key: 'soldCount', width: 16 },
      { key: 'availableEnd', width: 18 },
      { key: 'soldArea', width: 18 },
      { key: 'salesAmount', width: 18 },
      { key: 'totalSettled', width: 18 },
      { key: 'paidPercent', width: 14 },
      { key: 'remainingDebt', width: 18 },
      { key: 'debtPercent', width: 14 }
    ];

    const titleRow = summarySheet.addRow(['ОТЧЁТ О ПРОДАЖАХ КВАРТИР']);
    summarySheet.mergeCells('A1:K1');
    titleRow.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF0F172A' } };
    titleRow.height = 24;

    summarySheet.addRow(['Выбранный период:', periodLabel, '', 'Дата формирования:', `${report.generatedAtLabel} (Asia/Dushanbe)`]);
    summarySheet.addRow(['Жилой комплекс:', complexFilterLabel, '', 'Блок:', blockFilterLabel]);
    summarySheet.addRow([]);

    // Summary KPIs section
    const kpiHeaderRow = summarySheet.addRow(['Сводные показатели за период']);
    summarySheet.mergeCells(`A${kpiHeaderRow.number}:K${kpiHeaderRow.number}`);
    kpiHeaderRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1E293B' } };

    const kpiRows = [
      ['Свободно на начало периода, шт.', report.summary.totalAvailableStartCount, '#,##0', 'Сумма продаж, USD', report.summary.totalSalesAmountUsd, '#,##0.00'],
      ['Продано за период, шт.', report.summary.totalSoldCount, '#,##0', 'Получено всего (на конец периода), USD', report.summary.totalSettledUsd, '#,##0.00'],
      ['Осталось свободных на конец периода, шт.', report.summary.totalAvailableEndCount, '#,##0', '   в т.ч. денежными средствами, USD', report.summary.totalPaidCashUsd, '#,##0.00'],
      ['Проданная площадь, м²', report.summary.totalAreaM2, '#,##0.00', '   в т.ч. бартером (зачёт), USD', report.summary.totalPaidBarterUsd, '#,##0.00'],
      ['Средняя площадь квартиры, м²', report.summary.averageAreaM2, '#,##0.00', 'Остаток долга (на конец периода), USD', report.summary.totalRemainingDebtUsd, '#,##0.00'],
      ['Оплачено, %', report.summary.totalPaidPercent, '0.00"%"', 'Долг, %', report.summary.totalDebtPercent, '0.00"%"']
    ];

    for (const [labelL, valL, fmtL, labelR, valR, fmtR] of kpiRows) {
      const r = summarySheet.addRow([labelL, '', valL, '', labelR, '', valR]);
      r.getCell(3).numFmt = fmtL;
      r.getCell(3).font = { bold: true };
      r.getCell(7).numFmt = fmtR;
      r.getCell(7).font = { bold: true };
    }

    summarySheet.addRow([]);

    // Main Table Header (11 columns: ЖК, Блок + 9 metrics)
    const tableHeaderRow = summarySheet.addRow([
      'Жилой комплекс',
      'Блок',
      'Свободно на начало периода, шт.',
      'Продано за период, шт.',
      'Осталось свободных на конец периода, шт.',
      'Проданная площадь, м²',
      'Сумма продаж, USD',
      'Получено, USD',
      'Оплачено, %',
      'Остаток долга, USD',
      'Долг, %'
    ]);
    tableHeaderRow.height = 28;
    tableHeaderRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 3 ? 'right' : colNumber === 2 ? 'center' : 'left',
        wrapText: true
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });

    for (const block of report.blocks) {
      const row = summarySheet.addRow([
        block.projectName,
        block.blockCode,
        block.availableStartCount,
        block.soldCount,
        block.availableEndCount,
        block.soldAreaM2,
        block.salesAmountUsd,
        block.totalSettledUsd,
        block.paidPercent,
        block.remainingDebtUsd,
        block.debtPercent
      ]);
      row.height = 20;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      for (let c = 3; c <= 11; c += 1) {
        row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
      }
      row.getCell(3).numFmt = '#,##0';
      row.getCell(4).numFmt = '#,##0';
      row.getCell(5).numFmt = '#,##0';
      row.getCell(6).numFmt = '#,##0.00';
      row.getCell(7).numFmt = '#,##0.00';
      row.getCell(8).numFmt = '#,##0.00';
      row.getCell(9).numFmt = '0.00"%"';
      row.getCell(10).numFmt = '#,##0.00';
      row.getCell(11).numFmt = '0.00"%"';

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
    }

    const totalRow = summarySheet.addRow([
      'ИТОГО',
      '',
      report.totals.availableStartCount,
      report.totals.soldCount,
      report.totals.availableEndCount,
      report.totals.soldAreaM2,
      report.totals.salesAmountUsd,
      report.totals.totalSettledUsd,
      report.totals.paidPercent,
      report.totals.remainingDebtUsd,
      report.totals.debtPercent
    ]);
    totalRow.height = 22;
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 3 ? 'right' : 'left'
      };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'double', color: { argb: 'FF475569' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    totalRow.getCell(3).numFmt = '#,##0';
    totalRow.getCell(4).numFmt = '#,##0';
    totalRow.getCell(5).numFmt = '#,##0';
    totalRow.getCell(6).numFmt = '#,##0.00';
    totalRow.getCell(7).numFmt = '#,##0.00';
    totalRow.getCell(8).numFmt = '#,##0.00';
    totalRow.getCell(9).numFmt = '0.00"%"';
    totalRow.getCell(10).numFmt = '#,##0.00';
    totalRow.getCell(11).numFmt = '0.00"%"';

    // =========================================================================
    // SHEET 2: Детализация квартир
    // =========================================================================
    const detailsSheet = workbook.addWorksheet('Детализация квартир', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    detailsSheet.columns = [
      { key: 'index', width: 6 },
      { key: 'contractDate', width: 14 },
      { key: 'contractNumber', width: 18 },
      { key: 'projectName', width: 18 },
      { key: 'blockCode', width: 8 },
      { key: 'unitNumber', width: 12 },
      { key: 'floorNumber', width: 8 },
      { key: 'areaM2', width: 14 },
      { key: 'contractPriceUsd', width: 18 },
      { key: 'paidCashUsd', width: 18 },
      { key: 'paidBarterUsd', width: 16 },
      { key: 'totalSettledUsd', width: 18 },
      { key: 'remainingDebtUsd', width: 18 },
      { key: 'paidPercent', width: 13 },
      { key: 'debtPercent', width: 13 }
    ];

    const detailTitle = detailsSheet.addRow([
      `ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР (${periodLabel})`
    ]);
    detailsSheet.mergeCells('A1:O1');
    detailTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF0F172A' } };
    detailTitle.height = 24;

    detailsSheet.addRow([
      'Фильтры:',
      `ЖК: ${complexFilterLabel}; Блок: ${blockFilterLabel}`,
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
      'Номер квартиры',
      'Этаж',
      'Площадь, м²',
      'Договорная стоимость, USD',
      'Получено деньгами, USD',
      'Зачтено бартером, USD',
      'Всего погашено, USD',
      'Остаток задолженности, USD',
      'Оплачено, %',
      'Долг, %'
    ]);
    detailHeader.height = 28;
    detailHeader.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 8 ? 'right' : [1, 2, 5, 6, 7].includes(colNumber) ? 'center' : 'left',
        wrapText: true
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });

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
        apt.paidPercent,
        apt.debtPercent
      ]);
      row.height = 19;
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(4).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
      for (let c = 8; c <= 15; c += 1) {
        row.getCell(c).alignment = { vertical: 'middle', horizontal: 'right' };
      }
      row.getCell(8).numFmt = '#,##0.00';
      row.getCell(9).numFmt = '#,##0.00';
      row.getCell(10).numFmt = '#,##0.00';
      row.getCell(11).numFmt = '#,##0.00';
      row.getCell(12).numFmt = '#,##0.00';
      row.getCell(13).numFmt = '#,##0.00';
      row.getCell(14).numFmt = '0.00"%"';
      row.getCell(15).numFmt = '0.00"%"';

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
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
      report.totals.paidPercent,
      report.totals.debtPercent
    ]);
    detailTotalRow.height = 22;
    detailTotalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 8 ? 'right' : 'left'
      };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'double', color: { argb: 'FF475569' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    });
    detailTotalRow.getCell(8).numFmt = '#,##0.00';
    detailTotalRow.getCell(9).numFmt = '#,##0.00';
    detailTotalRow.getCell(10).numFmt = '#,##0.00';
    detailTotalRow.getCell(11).numFmt = '#,##0.00';
    detailTotalRow.getCell(12).numFmt = '#,##0.00';
    detailTotalRow.getCell(13).numFmt = '#,##0.00';
    detailTotalRow.getCell(14).numFmt = '0.00"%"';
    detailTotalRow.getCell(15).numFmt = '0.00"%"';

    return workbook.xlsx.writeBuffer();
  }
}
