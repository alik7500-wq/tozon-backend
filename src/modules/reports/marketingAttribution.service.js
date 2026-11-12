import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const getSecureDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

export const SALES_SOURCES = {
  DIRECT: 'DIRECT',
  MARKETER: 'MARKETER',
  UNSPECIFIED: 'UNSPECIFIED',
};

export const SALES_SOURCE_LABELS = {
  DIRECT: 'Прямая продажа TOZON',
  MARKETER: 'Продажа через маркетологов',
  UNSPECIFIED: 'Источник не определён',
};

export const COMMISSION_STATUSES = {
  NOT_CALCULATED: 'NOT_CALCULATED',
  CALCULATED: 'CALCULATED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
};

export const COMMISSION_STATUS_LABELS = {
  NOT_CALCULATED: 'Не рассчитана',
  CALCULATED: 'Рассчитана',
  PENDING_APPROVAL: 'На утверждении',
  APPROVED: 'Утверждена',
  PARTIALLY_PAID: 'Частично выплачена',
  PAID: 'Выплачена',
  CANCELLED: 'Отменена',
};

export const AUDIT_ACTION_SALES_SOURCE = 'SET_SALES_SOURCE';
export const AUDIT_ACTION_COMMISSION = 'UPDATE_COMMISSION_STATUS';
export const DICTIONARY_TYPE_PARTNER = 'MARKETING_PARTNER';

function toMinorUnits(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function minorToUsd(minor) {
  return Number((toMinorUnits(minor) / 100).toFixed(2));
}

function normalizeRole(user) {
  return String(user?.role || '').trim().toUpperCase();
}

export function encodePartnerMetadata({
  contactPerson = '',
  phone = '',
  commissionType = 'NONE',
  commissionRateBp = 0,
  commissionFixedMinor = 0,
  commissionTerms = '',
  cooperationStartDate = null,
  notes = '',
}) {
  return JSON.stringify({
    contact_person: String(contactPerson || '').trim(),
    phone: String(phone || '').trim(),
    commission_type: ['NONE', 'PERCENT', 'FIXED_USD'].includes(commissionType) ? commissionType : 'NONE',
    commission_rate_bp: Math.max(0, Math.min(10000, Math.round(Number(commissionRateBp) || 0))),
    commission_fixed_minor: Math.max(0, Math.round(Number(commissionFixedMinor) || 0)),
    commission_terms: String(commissionTerms || '').trim(),
    cooperation_start_date: cooperationStartDate || null,
    notes: String(notes || '').trim(),
  });
}

export function decodePartnerFromDictionaryRow(row) {
  let meta = {};
  if (row?.code) {
    try {
      meta = JSON.parse(row.code);
    } catch {
      meta = { notes: String(row.code) };
    }
  }
  const rateBp = Math.max(0, Math.min(10000, Math.round(Number(meta.commission_rate_bp) || 0)));
  const fixedMinor = Math.max(0, Math.round(Number(meta.commission_fixed_minor) || 0));
  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    contactPerson: meta.contact_person || '',
    phone: meta.phone || '',
    isActive: row.is_active !== false,
    commissionType: ['NONE', 'PERCENT', 'FIXED_USD'].includes(meta.commission_type)
      ? meta.commission_type
      : 'NONE',
    commissionRateBp: rateBp,
    commissionRatePercent: Number((rateBp / 100).toFixed(2)),
    commissionFixedMinor: fixedMinor,
    commissionFixedUsd: minorToUsd(fixedMinor),
    commissionTerms: meta.commission_terms || '',
    cooperationStartDate: meta.cooperation_start_date || null,
    notes: meta.notes || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function normalizePartnerFromTableRow(row) {
  const rateBp = Math.max(0, Math.min(10000, Math.round(Number(row.commission_rate_bp) || 0)));
  const fixedMinor = Math.max(0, Math.round(Number(row.commission_fixed_minor) || 0));
  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    contactPerson: row.contact_person || '',
    phone: row.phone || '',
    isActive: row.is_active !== false,
    commissionType: ['NONE', 'PERCENT', 'FIXED_USD'].includes(row.commission_type)
      ? row.commission_type
      : 'NONE',
    commissionRateBp: rateBp,
    commissionRatePercent: Number((rateBp / 100).toFixed(2)),
    commissionFixedMinor: fixedMinor,
    commissionFixedUsd: minorToUsd(fixedMinor),
    commissionTerms: row.commission_terms || '',
    cooperationStartDate: row.cooperation_start_date || null,
    notes: row.notes || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Pure calculation of deal sales source attribution and marketer commission state.
 * Never auto-assigns DIRECT or MARKETER to historical deals that lack explicit confirmation.
 * Never auto-calculates commission if rate is not configured or source is DIRECT/UNSPECIFIED.
 */
export function resolveDealAttributionAndCommission({
  deal,
  auditLogs = [],
  partnersMap = new Map(),
  usersMap = new Map(),
  dedicatedCommissionRow = null,
}) {
  const contractPriceMinor = toMinorUnits(deal?.final_price_minor ?? deal?.total_amount_minor);
  const contractPriceUsd = minorToUsd(contractPriceMinor);
  const isDealCancelled = String(deal?.status || '').toUpperCase() === 'CANCELLED' || Boolean(deal?.cancelled_at);
  const isDealNotSignedYet = Boolean(deal?.status) && !['SIGNED', 'CANCELLED'].includes(String(deal?.status || '').toUpperCase());

  // Sort audit logs chronologically (oldest -> newest)
  const sortedLogs = [...(auditLogs || [])].sort((a, b) => {
    const timeDiff = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    if (timeDiff !== 0) return timeDiff;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  const sourceLogs = sortedLogs.filter((log) => log.action === AUDIT_ACTION_SALES_SOURCE);
  const commissionLogs = sortedLogs.filter((log) => log.action === AUDIT_ACTION_COMMISSION);

  // Determine current sales source:
  // 1) Explicit column on deal if migration 055 is present, OR latest audit log
  let salesSource = SALES_SOURCES.UNSPECIFIED;
  let marketingPartnerId = null;
  let marketerName = '';
  let sourceConfirmedBy = null;
  let sourceConfirmedAt = null;

  if (
    deal?.sales_source &&
    [SALES_SOURCES.DIRECT, SALES_SOURCES.MARKETER, SALES_SOURCES.UNSPECIFIED].includes(deal.sales_source)
  ) {
    salesSource = deal.sales_source;
    marketingPartnerId = deal.marketing_partner_id ? Number(deal.marketing_partner_id) : null;
    marketerName = deal.marketer_name || '';
    sourceConfirmedBy = deal.source_confirmed_by ? Number(deal.source_confirmed_by) : null;
    sourceConfirmedAt = deal.source_confirmed_at || null;
  }

  const sourceHistory = [];
  for (const log of sourceLogs) {
    const payload = typeof log.changes_json === 'string'
      ? (() => { try { return JSON.parse(log.changes_json); } catch { return {}; } })()
      : (log.changes_json || {});

    const nextSource = [SALES_SOURCES.DIRECT, SALES_SOURCES.MARKETER, SALES_SOURCES.UNSPECIFIED].includes(payload.new_source)
      ? payload.new_source
      : SALES_SOURCES.UNSPECIFIED;

    const oldPartner = payload.old_partner_id ? partnersMap.get(Number(payload.old_partner_id)) : null;
    const newPartner = payload.new_partner_id ? partnersMap.get(Number(payload.new_partner_id)) : null;
    const userObj = log.user_id ? usersMap.get(Number(log.user_id)) : null;

    sourceHistory.push({
      id: log.id,
      dealId: deal?.id,
      oldSource: payload.old_source || SALES_SOURCES.UNSPECIFIED,
      oldSourceLabel: SALES_SOURCE_LABELS[payload.old_source || SALES_SOURCES.UNSPECIFIED] || 'Источник не определён',
      newSource: nextSource,
      newSourceLabel: SALES_SOURCE_LABELS[nextSource],
      oldPartnerId: payload.old_partner_id ? Number(payload.old_partner_id) : null,
      oldPartnerName: oldPartner?.name || payload.old_partner_name || null,
      newPartnerId: payload.new_partner_id ? Number(payload.new_partner_id) : null,
      newPartnerName: newPartner?.name || payload.new_partner_name || null,
      marketerName: payload.marketer_name || '',
      reason: payload.reason || '',
      changedBy: log.user_id ? Number(log.user_id) : null,
      changedByName: userObj?.name || userObj?.full_name || payload.user_name || (log.user_id ? `ID ${log.user_id}` : 'Система'),
      changedAt: log.created_at || payload.changed_at || null,
    });

    salesSource = nextSource;
    marketingPartnerId = nextSource === SALES_SOURCES.MARKETER && payload.new_partner_id
      ? Number(payload.new_partner_id)
      : null;
    marketerName = nextSource === SALES_SOURCES.MARKETER ? String(payload.marketer_name || '').trim() : '';
    sourceConfirmedBy = log.user_id ? Number(log.user_id) : null;
    sourceConfirmedAt = log.created_at || payload.changed_at || null;
  }

  const partner = marketingPartnerId ? partnersMap.get(Number(marketingPartnerId)) || null : null;
  const marketingPartnerName = partner?.name || deal?.marketing_partner_name || null;

  // Rule 1: Direct sales or Unspecified sales NEVER accrue marketer commission
  if (salesSource !== SALES_SOURCES.MARKETER) {
    return {
      salesSource,
      salesSourceLabel: SALES_SOURCE_LABELS[salesSource] || SALES_SOURCE_LABELS.UNSPECIFIED,
      marketingPartnerId: null,
      marketingPartnerName: null,
      marketerName: '',
      sourceConfirmedBy,
      sourceConfirmedAt,
      commission: {
        status: COMMISSION_STATUSES.NOT_CALCULATED,
        statusLabel: COMMISSION_STATUS_LABELS.NOT_CALCULATED,
        commissionType: 'NONE',
        commissionRateBp: 0,
        commissionRatePercent: 0,
        commissionTerms: '',
        contractPriceMinor,
        contractPriceUsd,
        calculatedCommissionMinor: 0,
        calculatedCommissionUsd: 0,
        approvedCommissionMinor: 0,
        approvedCommissionUsd: 0,
        paidCommissionMinor: 0,
        paidCommissionUsd: 0,
        remainingCommissionMinor: 0,
        remainingCommissionUsd: 0,
        accruedAt: null,
        approvedAt: null,
        approvedBy: null,
        paidAt: null,
        cancelledAt: null,
        cancelReason: null,
        notes: '',
      },
      sourceHistory: sourceHistory.reverse(),
      commissionHistory: [],
    };
  }

  // Rule 2: Sales through Marketers (MARKETER)
  // Determine base rate from partner or deal if configured, without inventing any default percentage
  let commissionType = deal?.commission_type || partner?.commissionType || 'NONE';
  let commissionRateBp = deal?.commission_rate_bp !== undefined
    ? Number(deal.commission_rate_bp)
    : deal?.commission_rate_percent !== undefined
      ? Math.round(Number(deal.commission_rate_percent) * 100)
      : (partner?.commissionRateBp || 0);
  let commissionFixedMinor = deal?.commission_fixed_minor !== undefined
    ? Number(deal.commission_fixed_minor)
    : (partner?.commissionFixedMinor || 0);
  let commissionTerms = partner?.commissionTerms || '';
  let calculatedCommissionMinor = 0;
  let approvedCommissionMinor = 0;
  let paidCommissionMinor = 0;
  let status = COMMISSION_STATUSES.NOT_CALCULATED;
  let accruedAt = null;
  let approvedAt = null;
  let approvedBy = null;
  let paidAt = null;
  let cancelledAt = null;
  let cancelReason = null;
  let notes = '';

  if (!isDealNotSignedYet) {
    if (commissionType === 'PERCENT' && commissionRateBp > 0) {
      calculatedCommissionMinor = Math.round((contractPriceMinor * commissionRateBp) / 10000);
      status = COMMISSION_STATUSES.CALCULATED;
      accruedAt = sourceConfirmedAt || deal?.deal_date || deal?.created_at || null;
    } else if (commissionType === 'FIXED_USD' && commissionFixedMinor > 0) {
      calculatedCommissionMinor = commissionFixedMinor;
      status = COMMISSION_STATUSES.CALCULATED;
      accruedAt = sourceConfirmedAt || deal?.deal_date || deal?.created_at || null;
    }
  }

  // Support explicit deal-level commission overrides (for unit tests or migration 055)
  if (deal?.commission && typeof deal.commission === 'object') {
    const dc = deal.commission;
    if (dc.commissionType) commissionType = dc.commissionType;
    if (dc.commissionRateBp !== undefined) commissionRateBp = Number(dc.commissionRateBp);
    if (dc.commissionRatePercent !== undefined) commissionRateBp = Math.round(Number(dc.commissionRatePercent) * 100);
    if (dc.calculatedCommissionMinor !== undefined) {
      calculatedCommissionMinor = toMinorUnits(dc.calculatedCommissionMinor);
    } else if (dc.calculatedCommissionUsd !== undefined) {
      calculatedCommissionMinor = toMinorUnits(Number(dc.calculatedCommissionUsd) * 100);
    } else if (commissionType === 'PERCENT' && commissionRateBp > 0) {
      calculatedCommissionMinor = Math.round((contractPriceMinor * commissionRateBp) / 10000);
    }
    if (dc.approvedCommissionMinor !== undefined) {
      approvedCommissionMinor = toMinorUnits(dc.approvedCommissionMinor);
    } else if (dc.approvedCommissionUsd !== undefined) {
      approvedCommissionMinor = toMinorUnits(Number(dc.approvedCommissionUsd) * 100);
    }
    if (dc.paidCommissionMinor !== undefined) {
      paidCommissionMinor = toMinorUnits(dc.paidCommissionMinor);
    } else if (dc.paidCommissionUsd !== undefined) {
      paidCommissionMinor = toMinorUnits(Number(dc.paidCommissionUsd) * 100);
    }
    if (dc.status && COMMISSION_STATUSES[dc.status]) {
      status = dc.status;
    } else if (paidCommissionMinor > 0 && approvedCommissionMinor > 0) {
      status = paidCommissionMinor >= approvedCommissionMinor
        ? COMMISSION_STATUSES.PAID
        : COMMISSION_STATUSES.PARTIALLY_PAID;
    } else if (approvedCommissionMinor > 0) {
      status = COMMISSION_STATUSES.APPROVED;
    } else if (calculatedCommissionMinor > 0) {
      status = COMMISSION_STATUSES.CALCULATED;
    }
  }

  // If dedicated row exists from migration 055, apply its state
  if (dedicatedCommissionRow) {
    commissionType = dedicatedCommissionRow.commission_type || commissionType;
    commissionRateBp = Number(dedicatedCommissionRow.commission_rate_bp ?? commissionRateBp);
    calculatedCommissionMinor = toMinorUnits(dedicatedCommissionRow.calculated_amount_minor);
    approvedCommissionMinor = toMinorUnits(dedicatedCommissionRow.approved_amount_minor);
    paidCommissionMinor = toMinorUnits(dedicatedCommissionRow.paid_amount_minor);
    status = dedicatedCommissionRow.status || status;
    accruedAt = dedicatedCommissionRow.accrued_at || accruedAt;
    approvedAt = dedicatedCommissionRow.approved_at || null;
    approvedBy = dedicatedCommissionRow.approved_by || null;
    paidAt = dedicatedCommissionRow.paid_at || null;
    cancelledAt = dedicatedCommissionRow.cancelled_at || null;
    cancelReason = dedicatedCommissionRow.cancel_reason || null;
    notes = dedicatedCommissionRow.notes || '';
  }

  // Apply commission audit logs in chronological order
  const commissionHistory = [];
  for (const log of commissionLogs) {
    const payload = typeof log.changes_json === 'string'
      ? (() => { try { return JSON.parse(log.changes_json); } catch { return {}; } })()
      : (log.changes_json || {});

    const userObj = log.user_id ? usersMap.get(Number(log.user_id)) : null;

    if (payload.commission_type) {
      commissionType = payload.commission_type;
    }
    if (payload.commission_rate_bp !== undefined) {
      commissionRateBp = Math.max(0, Math.min(10000, Math.round(Number(payload.commission_rate_bp) || 0)));
    }
    if (payload.commission_fixed_minor !== undefined) {
      commissionFixedMinor = Math.max(0, Math.round(Number(payload.commission_fixed_minor) || 0));
    }
    if (payload.commission_terms !== undefined) {
      commissionTerms = String(payload.commission_terms || '');
    }
    if (payload.calculated_amount_minor !== undefined) {
      calculatedCommissionMinor = toMinorUnits(payload.calculated_amount_minor);
    } else if (commissionType === 'PERCENT' && commissionRateBp > 0) {
      calculatedCommissionMinor = Math.round((contractPriceMinor * commissionRateBp) / 10000);
    } else if (commissionType === 'FIXED_USD' && commissionFixedMinor > 0) {
      calculatedCommissionMinor = commissionFixedMinor;
    }

    if (payload.approved_amount_minor !== undefined) {
      approvedCommissionMinor = toMinorUnits(payload.approved_amount_minor);
    }
    if (payload.paid_amount_minor !== undefined) {
      paidCommissionMinor = toMinorUnits(payload.paid_amount_minor);
    }
    if (payload.status && COMMISSION_STATUSES[payload.status]) {
      status = payload.status;
    }
    if (payload.accrued_at) accruedAt = payload.accrued_at;
    if (payload.approved_at) approvedAt = payload.approved_at;
    if (payload.approved_by) approvedBy = Number(payload.approved_by);
    if (payload.paid_at) paidAt = payload.paid_at;
    if (payload.cancelled_at) cancelledAt = payload.cancelled_at;
    if (payload.cancel_reason !== undefined) cancelReason = payload.cancel_reason;
    if (payload.notes !== undefined) notes = payload.notes;

    commissionHistory.push({
      id: log.id,
      actionType: payload.action_type || 'UPDATE',
      status,
      statusLabel: COMMISSION_STATUS_LABELS[status] || status,
      calculatedCommissionUsd: minorToUsd(calculatedCommissionMinor),
      approvedCommissionUsd: minorToUsd(approvedCommissionMinor),
      paidCommissionUsd: minorToUsd(paidCommissionMinor),
      notes: payload.notes || payload.cancel_reason || '',
      changedBy: log.user_id ? Number(log.user_id) : null,
      changedByName: userObj?.name || userObj?.full_name || payload.user_name || (log.user_id ? `ID ${log.user_id}` : 'Система'),
      changedAt: log.created_at || null,
    });
  }

  // Rule 3 (Stage 4.3): If deal is terminated (CANCELLED), block new accrual,
  // cancel unpaid commission, and preserve already paid commission in history.
  if (isDealCancelled) {
    status = COMMISSION_STATUSES.CANCELLED;
    calculatedCommissionMinor = paidCommissionMinor;
    approvedCommissionMinor = paidCommissionMinor;
    cancelledAt = cancelledAt || deal?.cancelled_at || deal?.updated_at || null;
    cancelReason = cancelReason || deal?.cancellation_reason || 'Договор расторгнут';
  }

  const remainingCommissionMinor = status === COMMISSION_STATUSES.CANCELLED
    ? 0
    : Math.max(0, approvedCommissionMinor - paidCommissionMinor);

  const commissionRatePercent = Number((commissionRateBp / 100).toFixed(2));

  return {
    salesSource,
    salesSourceLabel: SALES_SOURCE_LABELS[salesSource],
    marketingPartnerId: marketingPartnerId ? Number(marketingPartnerId) : null,
    marketingPartnerName,
    marketerName,
    sourceConfirmedBy,
    sourceConfirmedAt,
    commission: {
      status,
      statusLabel: COMMISSION_STATUS_LABELS[status] || status,
      commissionType,
      commissionRateBp,
      commissionRatePercent,
      commissionTerms,
      contractPriceMinor,
      contractPriceUsd,
      calculatedCommissionMinor,
      calculatedCommissionUsd: minorToUsd(calculatedCommissionMinor),
      approvedCommissionMinor,
      approvedCommissionUsd: minorToUsd(approvedCommissionMinor),
      paidCommissionMinor,
      paidCommissionUsd: minorToUsd(paidCommissionMinor),
      remainingCommissionMinor,
      remainingCommissionUsd: minorToUsd(remainingCommissionMinor),
      accruedAt,
      approvedAt,
      approvedBy,
      paidAt,
      cancelledAt,
      cancelReason,
      notes,
    },
    sourceHistory: sourceHistory.reverse(),
    commissionHistory: commissionHistory.reverse(),
  };
}

export class MarketingAttributionService {
  constructor(dbProvider = getSecureDB) {
    this.dbProvider = dbProvider;
  }

  getDb() {
    return this.dbProvider();
  }

  async getMarketingPartners({ includeInactive = false, user = null } = {}) {
    const db = this.getDb(user);
    const mergedById = new Map();
    const seenNames = new Set();

    // 1. Read from dedicated `marketing_partners` table if migration 055 is applied
    try {
      const { data: dedicatedData, error: dedicatedError } = await db
        .from('marketing_partners')
        .select('*')
        .order('name', { ascending: true });

      if (!dedicatedError && Array.isArray(dedicatedData)) {
        for (const row of dedicatedData) {
          const norm = normalizePartnerFromTableRow(row);
          mergedById.set(Number(norm.id), norm);
          seenNames.add(String(norm.name || '').trim().toLowerCase());
        }
      }
    } catch {
      // Migration 055 not applied yet
    }

    // 2. Also read from `public.dictionaries` (`type = 'MARKETING_PARTNER'`) so zero partners are lost
    //    when transitioning from hybrid storage to dedicated tables
    let query = db
      .from('dictionaries')
      .select('*')
      .eq('type', DICTIONARY_TYPE_PARTNER)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    const { data, error } = await query;
    if (error && mergedById.size === 0) {
      throw new AppError(`Ошибка загрузки маркетинговых партнёров: ${error.message}`, 500, 'MARKETING_PARTNERS_LOAD_FAILED');
    }

    for (const row of data || []) {
      const norm = decodePartnerFromDictionaryRow(row);
      const nameKey = String(norm.name || '').trim().toLowerCase();
      if (!mergedById.has(Number(norm.id)) && !seenNames.has(nameKey)) {
        mergedById.set(Number(norm.id), norm);
        seenNames.add(nameKey);
      }
    }

    const allPartners = Array.from(mergedById.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    );
    return includeInactive ? allPartners : allPartners.filter((p) => p.isActive);
  }

  async getPartnersMap({ user = null } = {}) {
    const partners = await this.getMarketingPartners({ includeInactive: true, user });
    return new Map(partners.map((p) => [Number(p.id), p]));
  }

  async createMarketingPartner(payload, user) {
    if (normalizeRole(user) !== 'ADMIN') {
      throw new AppError('Только администратор (ADMIN) может добавлять маркетинговых партнёров', 403, 'FORBIDDEN');
    }

    const name = String(payload?.name || '').trim();
    if (!name) {
      throw new AppError('Укажите наименование маркетингового партнёра', 400, 'PARTNER_NAME_REQUIRED');
    }

    const commissionType = ['NONE', 'PERCENT', 'FIXED_USD'].includes(payload?.commissionType)
      ? payload.commissionType
      : 'NONE';
    const commissionRatePercent = Number(payload?.commissionRatePercent ?? 0);
    const commissionRateBp = payload?.commissionRateBp !== undefined
      ? Math.round(Number(payload.commissionRateBp) || 0)
      : Math.round(commissionRatePercent * 100);
    const commissionFixedUsd = Number(payload?.commissionFixedUsd ?? 0);
    const commissionFixedMinor = payload?.commissionFixedMinor !== undefined
      ? Math.round(Number(payload.commissionFixedMinor) || 0)
      : Math.round(commissionFixedUsd * 100);

    if (commissionRateBp < 0 || commissionRateBp > 10000) {
      throw new AppError('Ставка комиссии должна быть от 0% до 100%', 400, 'INVALID_COMMISSION_RATE');
    }

    const db = this.getDb(user);

    // Check dedicated table first
    const { data: dedicatedProbe, error: probeError } = await db
      .from('marketing_partners')
      .select('id')
      .limit(1);

    if (!probeError && Array.isArray(dedicatedProbe)) {
      const { data: created, error: createErr } = await db
        .from('marketing_partners')
        .insert({
          name,
          contact_person: String(payload?.contactPerson || '').trim() || null,
          phone: String(payload?.phone || '').trim() || null,
          is_active: payload?.isActive !== false,
          commission_type: commissionType,
          commission_rate_bp: commissionType === 'PERCENT' ? commissionRateBp : 0,
          commission_fixed_minor: commissionType === 'FIXED_USD' ? commissionFixedMinor : 0,
          commission_terms: String(payload?.commissionTerms || '').trim() || null,
          cooperation_start_date: payload?.cooperationStartDate || null,
          notes: String(payload?.notes || '').trim() || null,
          created_by: user?.id ? Number(user.id) : null,
        })
        .select('*')
        .single();

      if (createErr) {
        throw new AppError(`Не удалось создать партнёра: ${createErr.message}`, 400, 'PARTNER_CREATE_FAILED');
      }
      return normalizePartnerFromTableRow(created);
    }

    // Fallback to `dictionaries`
    const metadataJson = encodePartnerMetadata({
      contactPerson: payload?.contactPerson,
      phone: payload?.phone,
      commissionType,
      commissionRateBp: commissionType === 'PERCENT' ? commissionRateBp : 0,
      commissionFixedMinor: commissionType === 'FIXED_USD' ? commissionFixedMinor : 0,
      commissionTerms: payload?.commissionTerms,
      cooperationStartDate: payload?.cooperationStartDate,
      notes: payload?.notes,
    });

    const { data: createdDict, error: dictErr } = await db
      .from('dictionaries')
      .insert({
        type: DICTIONARY_TYPE_PARTNER,
        name,
        code: metadataJson,
        is_active: payload?.isActive !== false,
        is_system: false,
        sort_order: 10,
      })
      .select('*')
      .single();

    if (dictErr) {
      throw new AppError(`Не удалось создать партнёра: ${dictErr.message}`, 400, 'PARTNER_CREATE_FAILED');
    }

    return decodePartnerFromDictionaryRow(createdDict);
  }

  async updateMarketingPartner(partnerId, payload, user) {
    if (normalizeRole(user) !== 'ADMIN') {
      throw new AppError('Только администратор (ADMIN) может редактировать маркетинговых партнёров', 403, 'FORBIDDEN');
    }

    const id = Number(partnerId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('Некорректный ID партнёра', 400, 'INVALID_PARTNER_ID');
    }

    const partnersMap = await this.getPartnersMap({ user });
    const existing = partnersMap.get(id);
    if (!existing) {
      throw new AppError('Маркетинговый партнёр не найден', 404, 'PARTNER_NOT_FOUND');
    }

    const name = payload?.name !== undefined ? String(payload.name).trim() : existing.name;
    if (!name) {
      throw new AppError('Наименование партнёра не может быть пустым', 400, 'PARTNER_NAME_REQUIRED');
    }

    const commissionType = payload?.commissionType !== undefined
      ? (['NONE', 'PERCENT', 'FIXED_USD'].includes(payload.commissionType) ? payload.commissionType : 'NONE')
      : existing.commissionType;

    const commissionRateBp = payload?.commissionRateBp !== undefined
      ? Math.round(Number(payload.commissionRateBp) || 0)
      : payload?.commissionRatePercent !== undefined
        ? Math.round(Number(payload.commissionRatePercent || 0) * 100)
        : existing.commissionRateBp;

    const commissionFixedMinor = payload?.commissionFixedMinor !== undefined
      ? Math.round(Number(payload.commissionFixedMinor) || 0)
      : payload?.commissionFixedUsd !== undefined
        ? Math.round(Number(payload.commissionFixedUsd || 0) * 100)
        : existing.commissionFixedMinor;

    const isActive = payload?.isActive !== undefined ? Boolean(payload.isActive) : existing.isActive;
    const contactPerson = payload?.contactPerson !== undefined ? payload.contactPerson : existing.contactPerson;
    const phone = payload?.phone !== undefined ? payload.phone : existing.phone;
    const commissionTerms = payload?.commissionTerms !== undefined ? payload.commissionTerms : existing.commissionTerms;
    const cooperationStartDate = payload?.cooperationStartDate !== undefined
      ? payload.cooperationStartDate
      : existing.cooperationStartDate;
    const notes = payload?.notes !== undefined ? payload.notes : existing.notes;

    const db = this.getDb(user);

    // Try dedicated table first
    const { data: dedicatedProbe, error: probeError } = await db
      .from('marketing_partners')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (!probeError && dedicatedProbe) {
      const { data: updated, error: updateErr } = await db
        .from('marketing_partners')
        .update({
          name,
          contact_person: String(contactPerson || '').trim() || null,
          phone: String(phone || '').trim() || null,
          is_active: isActive,
          commission_type: commissionType,
          commission_rate_bp: commissionType === 'PERCENT' ? commissionRateBp : 0,
          commission_fixed_minor: commissionType === 'FIXED_USD' ? commissionFixedMinor : 0,
          commission_terms: String(commissionTerms || '').trim() || null,
          cooperation_start_date: cooperationStartDate || null,
          notes: String(notes || '').trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select('*')
        .single();

      if (updateErr) {
        throw new AppError(`Ошибка обновления партнёра: ${updateErr.message}`, 400, 'PARTNER_UPDATE_FAILED');
      }
      return normalizePartnerFromTableRow(updated);
    }

    // Fallback to `dictionaries`
    const metadataJson = encodePartnerMetadata({
      contactPerson,
      phone,
      commissionType,
      commissionRateBp: commissionType === 'PERCENT' ? commissionRateBp : 0,
      commissionFixedMinor: commissionType === 'FIXED_USD' ? commissionFixedMinor : 0,
      commissionTerms,
      cooperationStartDate,
      notes,
    });

    const { data: updatedDict, error: dictErr } = await db
      .from('dictionaries')
      .update({
        name,
        code: metadataJson,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('type', DICTIONARY_TYPE_PARTNER)
      .select('*')
      .single();

    if (dictErr) {
      throw new AppError(`Ошибка обновления партнёра: ${dictErr.message}`, 400, 'PARTNER_UPDATE_FAILED');
    }

    return decodePartnerFromDictionaryRow(updatedDict);
  }

  async loadAttributionContextForDeals(dealIds = [], user = null) {
    const db = this.getDb(user);
    const partnersMap = await this.getPartnersMap({ user });

    const { data: usersData } = await db
      .from('users')
      .select('id, name, role');
    const usersMap = new Map((usersData || []).map((u) => [Number(u.id), u]));

    const logsByDealId = new Map();
    if (Array.isArray(dealIds) && dealIds.length > 0) {
      const uniqueIds = [...new Set(dealIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
      if (uniqueIds.length > 0) {
        const { data: auditData } = await db
          .from('deal_audit_logs')
          .select('id, deal_id, user_id, action, changes_json, created_at')
          .in('deal_id', uniqueIds)
          .in('action', [AUDIT_ACTION_SALES_SOURCE, AUDIT_ACTION_COMMISSION])
          .order('created_at', { ascending: true });

        for (const row of auditData || []) {
          const dId = Number(row.deal_id);
          if (!logsByDealId.has(dId)) {
            logsByDealId.set(dId, []);
          }
          logsByDealId.get(dId).push(row);
        }
      }
    }

    return {
      partnersMap,
      usersMap,
      logsByDealId,
    };
  }

  async enrichDealWithAttribution(deal, user = null) {
    if (!deal) return null;
    const { partnersMap, usersMap, logsByDealId } = await this.loadAttributionContextForDeals([deal.id], user);
    const attribution = resolveDealAttributionAndCommission({
      deal,
      auditLogs: logsByDealId.get(Number(deal.id)) || [],
      partnersMap,
      usersMap,
    });

    return {
      ...deal,
      sales_source: attribution.salesSource,
      sales_source_label: attribution.salesSourceLabel,
      marketing_partner_id: attribution.marketingPartnerId,
      marketing_partner_name: attribution.marketingPartnerName,
      marketer_name: attribution.marketerName,
      commission: attribution.commission,
      source_history: attribution.sourceHistory,
      commission_history: attribution.commissionHistory,
    };
  }

  async enrichDealsList(deals = [], user = null) {
    if (!Array.isArray(deals) || deals.length === 0) return [];
    const dealIds = deals.map((d) => Number(d.id)).filter((id) => Number.isInteger(id) && id > 0);
    const { partnersMap, usersMap, logsByDealId } = await this.loadAttributionContextForDeals(dealIds, user);

    return deals.map((deal) => {
      const attribution = resolveDealAttributionAndCommission({
        deal,
        auditLogs: logsByDealId.get(Number(deal.id)) || [],
        partnersMap,
        usersMap,
      });
      return {
        ...deal,
        sales_source: attribution.salesSource,
        sales_source_label: attribution.salesSourceLabel,
        marketing_partner_id: attribution.marketingPartnerId,
        marketing_partner_name: attribution.marketingPartnerName,
        marketer_name: attribution.marketerName,
        commission: attribution.commission,
        source_history: attribution.sourceHistory,
        commission_history: attribution.commissionHistory,
      };
    });
  }

  /**
   * Updates the sales source for a deal with strict RBAC and mandatory audit logging.
   * Stage 3.2 & Stage 8 rules:
   * - If deal is SIGNED: ONLY ADMIN can modify the sales source, and `reason` is required!
   * - If deal is NOT SIGNED (e.g. RESERVED / DRAFT): SALES_MANAGER, DIRECTOR, ADMIN can set source.
   * - If `salesSource === 'MARKETER'`, `marketingPartnerId` is required and must exist.
   */
  async updateDealSalesSource(dealId, payload, user, options = {}) {
    const id = Number(dealId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('Некорректный ID сделки', 400, 'INVALID_DEAL_ID');
    }

    const role = normalizeRole(user);
    if (!['ADMIN', 'DIRECTOR', 'SALES_MANAGER'].includes(role)) {
      throw new AppError('У вас нет прав для указания источника продажи', 403, 'FORBIDDEN');
    }

    const nextSource = String(payload?.salesSource || payload?.sales_source || '').trim().toUpperCase();
    if (![SALES_SOURCES.DIRECT, SALES_SOURCES.MARKETER, SALES_SOURCES.UNSPECIFIED].includes(nextSource)) {
      throw new AppError(
        'Укажите корректный источник продажи: DIRECT (Прямая продажа TOZON) или MARKETER (Продажа через маркетологов)',
        400,
        'INVALID_SALES_SOURCE'
      );
    }

    const db = this.getDb(user);
    const { data: deal, error: dealErr } = await db
      .from('deals')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (dealErr || !deal) {
      throw new AppError('Сделка не найдена', 404, 'DEAL_NOT_FOUND');
    }

    const { partnersMap, usersMap, logsByDealId } = await this.loadAttributionContextForDeals([id], user);
    const currentAttr = resolveDealAttributionAndCommission({
      deal,
      auditLogs: logsByDealId.get(id) || [],
      partnersMap,
      usersMap,
    });

    const isSigned = String(deal.status || '').toUpperCase() === 'SIGNED';
    const isInitialCreationOrSigning = Boolean(options?.isSigningFlow);
    const reason = String(payload?.reason || '').trim();

    // Post-signing protection (Stage 3.2):
    // Once a deal is SIGNED, regular managers cannot change the sales source.
    // Only ADMIN can change it, with a mandatory reason!
    if (isSigned && !isInitialCreationOrSigning) {
      if (role !== 'ADMIN') {
        throw new AppError(
          'После подписания договора изменить источник продажи может только администратор (ADMIN)',
          403,
          'SIGNED_DEAL_SOURCE_LOCKED'
        );
      }
      if (!reason || reason.length < 3) {
        throw new AppError(
          'При изменении источника продажи подписанного договора обязательно укажите причину изменения',
          400,
          'SOURCE_CHANGE_REASON_REQUIRED'
        );
      }
    }

    let partnerId = null;
    let partnerObj = null;
    const marketerName = nextSource === SALES_SOURCES.MARKETER
      ? String(payload?.marketerName ?? payload?.marketer_name ?? '').trim()
      : '';

    if (nextSource === SALES_SOURCES.MARKETER) {
      partnerId = Number(payload?.marketingPartnerId ?? payload?.marketing_partner_id);
      if (!Number.isInteger(partnerId) || partnerId <= 0) {
        throw new AppError(
          'При выборе «Продажа через маркетологов» необходимо выбрать маркетингового партнёра',
          400,
          'MARKETING_PARTNER_REQUIRED'
        );
      }
      partnerObj = partnersMap.get(partnerId);
      if (!partnerObj) {
        throw new AppError('Выбранный маркетинговый партнёр не найден в справочнике', 404, 'MARKETING_PARTNER_NOT_FOUND');
      }
    }

    // Protect against hiding an already-disbursed commission by changing sales source to DIRECT/UNSPECIFIED
    if (nextSource !== SALES_SOURCES.MARKETER && currentAttr.commission.paidCommissionMinor > 0) {
      throw new AppError(
        `Невозможно изменить источник продажи на «${SALES_SOURCE_LABELS[nextSource]}», так как по договору уже выплачена комиссия (${currentAttr.commission.paidCommissionUsd} USD).`,
        400,
        'COMMISSION_ALREADY_PAID_CANNOT_CHANGE_SOURCE'
      );
    }

    const nowIso = new Date().toISOString();
    const effectiveReason = reason || (isInitialCreationOrSigning ? 'Указан при оформлении договора' : 'Уточнение источника продажи');
    const auditPayload = {
      old_source: currentAttr.salesSource,
      new_source: nextSource,
      old_partner_id: currentAttr.marketingPartnerId,
      old_partner_name: currentAttr.marketingPartnerName,
      new_partner_id: partnerId,
      new_partner_name: partnerObj?.name || null,
      marketer_name: marketerName,
      reason: effectiveReason,
      user_name: user?.fullName || user?.full_name || user?.email || null,
      changed_at: nowIso,
    };

    const { error: logErr } = await db
      .from('deal_audit_logs')
      .insert({
        deal_id: id,
        user_id: user?.id ? Number(user.id) : null,
        action: AUDIT_ACTION_SALES_SOURCE,
        changes_json: auditPayload,
      });

    if (logErr) {
      throw new AppError(`Не удалось записать аудит источника продажи: ${logErr.message}`, 500, 'AUDIT_LOG_FAILED');
    }

    // Dual-write to dedicated columns/tables if migration 055 is applied
    try {
      await db
        .from('deals')
        .update({
          sales_source: nextSource,
          marketing_partner_id: partnerId,
          marketer_name: nextSource === SALES_SOURCES.MARKETER ? (marketerName || null) : null,
          source_confirmed_by: user?.id ? Number(user.id) : null,
          source_confirmed_at: nowIso,
        })
        .eq('id', id);

      await db.from('deal_source_history').insert({
        deal_id: id,
        old_source: currentAttr.salesSource,
        new_source: nextSource,
        old_partner_id: currentAttr.marketingPartnerId,
        new_partner_id: partnerId,
        new_marketer_name: marketerName || null,
        reason: effectiveReason,
        changed_by: user?.id ? Number(user.id) : null,
        changed_at: nowIso,
      });
    } catch {
      // Migration 055 not applied yet; hybrid audit log is already persisted
    }

    // If switched to DIRECT or UNSPECIFIED, cancel/reset any unpaid commission
    if (nextSource !== SALES_SOURCES.MARKETER && currentAttr.commission.status !== COMMISSION_STATUSES.NOT_CALCULATED) {
      await db.from('deal_audit_logs').insert({
        deal_id: id,
        user_id: user?.id ? Number(user.id) : null,
        action: AUDIT_ACTION_COMMISSION,
        changes_json: {
          action_type: 'RESET_FOR_DIRECT_SALE',
          status: COMMISSION_STATUSES.NOT_CALCULATED,
          calculated_amount_minor: 0,
          approved_amount_minor: 0,
          notes: `Источник изменён на «${SALES_SOURCE_LABELS[nextSource]}». Комиссия маркетологам = 0 USD.`,
          user_name: user?.fullName || user?.full_name || null,
        },
      });
      try {
        await db
          .from('marketing_commissions')
          .update({
            status: COMMISSION_STATUSES.NOT_CALCULATED,
            calculated_amount_minor: 0,
            approved_amount_minor: 0,
            updated_at: nowIso,
          })
          .eq('deal_id', id);
      } catch {
        // Migration 055 not applied yet
      }
    }

    return this.enrichDealWithAttribution(deal, user);
  }

  /**
   * Manages marketer commission lifecycle for a deal (`MARKETER` source only).
   * Supported actions:
   * - `SET_RATE`: ADMIN sets/updates commission rate or fixed amount for this deal.
   * - `SUBMIT_FOR_APPROVAL`: DIRECTOR or ADMIN moves commission to `PENDING_APPROVAL`.
   * - `APPROVE`: ADMIN approves the commission (`APPROVED`).
   * - `RECORD_PAYOUT`: FINANCE_MANAGER or ADMIN records payout (`PARTIALLY_PAID` / `PAID`).
   * - `CANCEL`: ADMIN cancels unpaid commission (`CANCELLED`).
   */
  async updateDealCommission(dealId, payload, user) {
    const id = Number(dealId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('Некорректный ID сделки', 400, 'INVALID_DEAL_ID');
    }

    const role = normalizeRole(user);
    if (role === 'SALES_MANAGER') {
      throw new AppError(
        'Менеджер продаж (SALES_MANAGER) не может утверждать, изменять или выплачивать комиссии маркетологов',
        403,
        'FORBIDDEN'
      );
    }

    const actionType = String(payload?.action || '').trim().toUpperCase();
    if (!['SET_RATE', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'RECORD_PAYOUT', 'CANCEL'].includes(actionType)) {
      throw new AppError('Укажите корректное действие по комиссии', 400, 'INVALID_COMMISSION_ACTION');
    }

    // Enforce granular RBAC per action (Stage 8)
    if (['SET_RATE', 'APPROVE', 'CANCEL'].includes(actionType) && role !== 'ADMIN') {
      throw new AppError(
        'Утверждение, настройка ставки и отмена комиссий доступны только администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }
    if (actionType === 'SUBMIT_FOR_APPROVAL' && !['ADMIN', 'DIRECTOR'].includes(role)) {
      throw new AppError(
        'Отправка комиссии на утверждение доступна только директору (DIRECTOR) или администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }
    if (actionType === 'RECORD_PAYOUT' && !['ADMIN', 'FINANCE_MANAGER'].includes(role)) {
      throw new AppError(
        'Регистрация выплаты комиссии доступна только финансовому менеджеру (FINANCE_MANAGER) или администратору (ADMIN)',
        403,
        'FORBIDDEN'
      );
    }

    const db = this.getDb(user);
    const { data: deal, error: dealErr } = await db
      .from('deals')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (dealErr || !deal) {
      throw new AppError('Сделка не найдена', 404, 'DEAL_NOT_FOUND');
    }

    if (String(deal.status || '').toUpperCase() === 'CANCELLED' || deal.cancelled_at) {
      throw new AppError('Невозможно начислить или выплатить комиссию по расторгнутому договору', 400, 'DEAL_CANCELLED');
    }

    if (String(deal.status || '').toUpperCase() !== 'SIGNED') {
      throw new AppError(
        'Начисление, утверждение и выплата комиссии возможны только по действующему подписанному договору (SIGNED)',
        400,
        'DEAL_NOT_SIGNED'
      );
    }

    const dealAuditLogs = (await this.loadAttributionContextForDeals([id], user));
    const { partnersMap, usersMap, logsByDealId } = dealAuditLogs;
    const existingLogs = logsByDealId.get(id) || [];
    const currentAttr = resolveDealAttributionAndCommission({
      deal,
      auditLogs: existingLogs,
      partnersMap,
      usersMap,
    });

    if (currentAttr.salesSource !== SALES_SOURCES.MARKETER) {
      throw new AppError(
        `Начисление комиссии запрещено для источника «${currentAttr.salesSourceLabel}». Комиссия начисляется только по подтверждённым продажам через маркетологов.`,
        400,
        'COMMISSION_NOT_ALLOWED_FOR_SOURCE'
      );
    }

    const contractPriceMinor = currentAttr.commission.contractPriceMinor;
    const nowIso = new Date().toISOString();
    const notes = String(payload?.notes || payload?.reason || '').trim();
    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey).trim() : null;

    let auditChanges = {
      action_type: actionType,
      notes,
      idempotency_key: idempotencyKey,
      user_name: user?.fullName || user?.full_name || null,
    };

    if (actionType === 'SET_RATE') {
      if (
        [
          COMMISSION_STATUSES.APPROVED,
          COMMISSION_STATUSES.PARTIALLY_PAID,
          COMMISSION_STATUSES.PAID,
        ].includes(currentAttr.commission.status)
      ) {
        throw new AppError(
          'Комиссия по данному договору уже утверждена или выплачена. Повторное начисление запрещено.',
          400,
          'COMMISSION_ALREADY_APPROVED_OR_PAID'
        );
      }

      const commissionType = ['PERCENT', 'FIXED_USD', 'NONE'].includes(payload?.commissionType)
        ? payload.commissionType
        : 'PERCENT';
      const ratePercent = Number(payload?.commissionRatePercent ?? 0);
      const rateBp = payload?.commissionRateBp !== undefined
        ? Math.round(Number(payload.commissionRateBp) || 0)
        : Math.round(ratePercent * 100);
      const fixedMinor = payload?.commissionFixedMinor !== undefined
        ? Math.round(Number(payload.commissionFixedMinor) || 0)
        : Math.round(Number(payload?.commissionFixedUsd || 0) * 100);

      if (rateBp < 0 || rateBp > 10000) {
        throw new AppError('Ставка комиссии должна быть от 0% до 100%', 400, 'INVALID_COMMISSION_RATE');
      }

      const calculatedMinor = commissionType === 'PERCENT'
        ? Math.round((contractPriceMinor * rateBp) / 10000)
        : commissionType === 'FIXED_USD'
          ? Math.max(0, fixedMinor)
          : 0;

      auditChanges = {
        ...auditChanges,
        commission_type: commissionType,
        commission_rate_bp: commissionType === 'PERCENT' ? rateBp : 0,
        commission_fixed_minor: commissionType === 'FIXED_USD' ? fixedMinor : 0,
        calculated_amount_minor: calculatedMinor,
        status: calculatedMinor > 0 ? COMMISSION_STATUSES.CALCULATED : COMMISSION_STATUSES.NOT_CALCULATED,
        accrued_at: calculatedMinor > 0 ? (currentAttr.commission.accruedAt || nowIso) : null,
      };
    } else if (actionType === 'SUBMIT_FOR_APPROVAL') {
      if (
        [
          COMMISSION_STATUSES.PENDING_APPROVAL,
          COMMISSION_STATUSES.APPROVED,
          COMMISSION_STATUSES.PARTIALLY_PAID,
          COMMISSION_STATUSES.PAID,
        ].includes(currentAttr.commission.status)
      ) {
        throw new AppError(
          `Комиссия уже находится в статусе «${currentAttr.commission.statusLabel}». Повторная отправка на утверждение запрещена.`,
          400,
          'COMMISSION_ALREADY_SUBMITTED_OR_APPROVED'
        );
      }
      if (currentAttr.commission.calculatedCommissionMinor <= 0) {
        throw new AppError(
          'Нельзя отправить на утверждение нулевую комиссию. Сначала укажите согласованную ставку комиссии.',
          400,
          'COMMISSION_ZERO'
        );
      }
      auditChanges = {
        ...auditChanges,
        status: COMMISSION_STATUSES.PENDING_APPROVAL,
        accrued_at: currentAttr.commission.accruedAt || nowIso,
      };
    } else if (actionType === 'APPROVE') {
      if (
        [
          COMMISSION_STATUSES.APPROVED,
          COMMISSION_STATUSES.PARTIALLY_PAID,
          COMMISSION_STATUSES.PAID,
        ].includes(currentAttr.commission.status)
      ) {
        throw new AppError(
          `Комиссия по данному договору уже утверждена (статус «${currentAttr.commission.statusLabel}»). Двойное утверждение запрещено.`,
          400,
          'COMMISSION_ALREADY_APPROVED'
        );
      }

      const customApprovedUsd = payload?.approvedCommissionUsd;
      const approvedMinor = customApprovedUsd !== undefined && customApprovedUsd !== null && customApprovedUsd !== ''
        ? Math.round(Number(customApprovedUsd) * 100)
        : currentAttr.commission.calculatedCommissionMinor;

      if (approvedMinor <= 0) {
        throw new AppError(
          'Утверждаемая сумма комиссии должна быть больше 0 USD',
          400,
          'APPROVED_COMMISSION_MUST_BE_POSITIVE'
        );
      }

      const newStatus = currentAttr.commission.paidCommissionMinor >= approvedMinor
        ? COMMISSION_STATUSES.PAID
        : currentAttr.commission.paidCommissionMinor > 0
          ? COMMISSION_STATUSES.PARTIALLY_PAID
          : COMMISSION_STATUSES.APPROVED;

      auditChanges = {
        ...auditChanges,
        approved_amount_minor: approvedMinor,
        status: newStatus,
        accrued_at: currentAttr.commission.accruedAt || nowIso,
        approved_at: nowIso,
        approved_by: user?.id ? Number(user.id) : null,
      };
    } else if (actionType === 'RECORD_PAYOUT') {
      if (currentAttr.commission.status === COMMISSION_STATUSES.PAID) {
        throw new AppError(
          'Комиссия по данному договору уже полностью выплачена. Повторная выплата запрещена.',
          400,
          'COMMISSION_ALREADY_FULLY_PAID'
        );
      }
      if (
        ![
          COMMISSION_STATUSES.APPROVED,
          COMMISSION_STATUSES.PARTIALLY_PAID,
        ].includes(currentAttr.commission.status)
      ) {
        throw new AppError(
          'Выплата возможна только по утверждённой комиссии (статус «Утверждена» или «Частично выплачена»)',
          400,
          'COMMISSION_NOT_APPROVED'
        );
      }

      const payoutUsd = Number(payload?.payoutAmountUsd ?? payload?.amountUsd ?? 0);
      const payoutMinor = payload?.payoutAmountMinor !== undefined
        ? Math.round(Number(payload.payoutAmountMinor) || 0)
        : Math.round(payoutUsd * 100);

      if (payoutMinor <= 0) {
        throw new AppError('Сумма выплаты комиссии должна быть больше 0 USD', 400, 'INVALID_PAYOUT_AMOUNT');
      }

      // Protection against duplicate payout request (explicit idempotencyKey)
      if (idempotencyKey) {
        const duplicateKeyExists = existingLogs.some((log) => {
          if (log.action !== AUDIT_ACTION_COMMISSION) return false;
          const p = typeof log.changes_json === 'string'
            ? (() => { try { return JSON.parse(log.changes_json); } catch { return {}; } })()
            : (log.changes_json || {});
          return p.action_type === 'RECORD_PAYOUT' && p.idempotency_key === idempotencyKey;
        });
        if (duplicateKeyExists) {
          throw new AppError(
            'Повторный запрос на выплату комиссии с тем же ключом идемпотентности заблокирован',
            409,
            'DUPLICATE_COMMISSION_PAYOUT'
          );
        }
      }

      const nextPaidMinor = currentAttr.commission.paidCommissionMinor + payoutMinor;
      if (nextPaidMinor > currentAttr.commission.approvedCommissionMinor) {
        throw new AppError(
          `Сумма выплаты превышает остаток утверждённой комиссии (${currentAttr.commission.remainingCommissionUsd} USD)`,
          400,
          'PAYOUT_EXCEEDS_APPROVED'
        );
      }

      const nextStatus = nextPaidMinor >= currentAttr.commission.approvedCommissionMinor
        ? COMMISSION_STATUSES.PAID
        : COMMISSION_STATUSES.PARTIALLY_PAID;

      auditChanges = {
        ...auditChanges,
        payout_delta_minor: payoutMinor,
        paid_amount_minor: nextPaidMinor,
        status: nextStatus,
        paid_at: nowIso,
      };
    } else if (actionType === 'CANCEL') {
      if (!notes || notes.length < 3) {
        throw new AppError('Укажите причину отмены комиссии', 400, 'CANCEL_REASON_REQUIRED');
      }
      auditChanges = {
        ...auditChanges,
        approved_amount_minor: currentAttr.commission.paidCommissionMinor,
        status: COMMISSION_STATUSES.CANCELLED,
        cancelled_at: nowIso,
        cancel_reason: notes,
      };
    }

    const { error: logErr } = await db
      .from('deal_audit_logs')
      .insert({
        deal_id: id,
        user_id: user?.id ? Number(user.id) : null,
        action: AUDIT_ACTION_COMMISSION,
        changes_json: auditChanges,
      });

    if (logErr) {
      throw new AppError(`Не удалось сохранить статус комиссии: ${logErr.message}`, 500, 'COMMISSION_UPDATE_FAILED');
    }

    const enriched = await this.enrichDealWithAttribution(deal, user);

    // Dual-write to dedicated `public.marketing_commissions` table if migration 055 is applied
    try {
      const c = enriched.commission;
      await db
        .from('marketing_commissions')
        .upsert(
          {
            deal_id: id,
            partner_id: enriched.marketing_partner_id,
            contract_price_minor: c.contractPriceMinor,
            commission_type: c.commissionType,
            commission_rate_bp: c.commissionRateBp,
            calculated_amount_minor: c.calculatedCommissionMinor,
            approved_amount_minor: c.approvedCommissionMinor,
            paid_amount_minor: c.paidCommissionMinor,
            status: c.status,
            accrued_at: c.accruedAt,
            approved_at: c.approvedAt,
            approved_by: c.approvedBy,
            paid_at: c.paidAt,
            cancelled_at: c.cancelledAt,
            cancel_reason: c.cancelReason,
            notes: c.notes,
            updated_at: nowIso,
          },
          { onConflict: 'deal_id' }
        );
    } catch {
      // Migration 055 not applied yet; hybrid audit log is already persisted
    }

    return enriched;
  }
}

export const marketingAttributionService = new MarketingAttributionService();
