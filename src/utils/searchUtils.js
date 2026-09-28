/**
 * Unified Search Utility for TOZON CRM Server & Client
 * Supports Tajik Unicode, Cyrillic, partial string matching,
 * digit-only phone matching, and multi-field search logic.
 */

export const normalizeSearchText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLocaleLowerCase();
};

export const extractDigits = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\D/g, '');
};

/**
 * Checks whether a phone number matches a search query regardless of formatting.
 * Handles +992, spaces, dashes, brackets, e.g., 928880702 matches +992 (92) 888-07-02
 */
export const matchPhone = (phoneValue, queryInput) => {
  if (!phoneValue || !queryInput) return false;
  const phoneDigits = extractDigits(phoneValue);
  const queryDigits = extractDigits(queryInput);
  if (!phoneDigits || !queryDigits) return false;

  if (phoneDigits.includes(queryDigits) || queryDigits.includes(phoneDigits)) return true;

  const cleanPhone = phoneDigits.startsWith('992') ? phoneDigits.slice(3) : phoneDigits;
  const cleanQuery = queryDigits.startsWith('992') ? queryDigits.slice(3) : queryDigits;

  return cleanQuery.length > 0 && (cleanPhone.includes(cleanQuery) || cleanQuery.includes(cleanPhone));
};

/**
 * Generic multi-field partial search matcher
 */
export const matchSearchQuery = (item, fields = [], searchQuery = '', options = {}) => {
  const q = normalizeSearchText(searchQuery);
  if (!q) return true;

  const qDigits = extractDigits(q);

  // 1. Text fields matching (Cyrillic, Tajik Unicode, partial match)
  for (const field of fields) {
    if (!field) continue;
    const val = item[field];
    if (val !== null && val !== undefined) {
      const normVal = normalizeSearchText(val);
      if (normVal.includes(q)) return true;
    }
  }

  // 2. Phone fields matching (normalized digits)
  const phoneFields = options.phoneFields || ['phone', 'lead_phone', 'clientPhone', 'recipient'];
  if (qDigits.length >= 3) {
    for (const pField of phoneFields) {
      const pVal = item[pField];
      if (pVal && matchPhone(pVal, qDigits)) return true;
    }
  }

  // 3. Combined passport matching (series + number)
  if (options.checkPassport !== false) {
    const series = normalizeSearchText(item.passport_series || item.passportSeries || '');
    const number = normalizeSearchText(item.passport_number || item.passportNumber || '');
    const fullPassport = `${series} ${number}`.trim();
    const compactPassport = `${series}${number}`.trim();
    if (fullPassport && (fullPassport.includes(q) || compactPassport.includes(q))) return true;
  }

  // 4. Apartment unit number matching
  const unitFields = options.unitFields || ['unit_number', 'unitNumber', 'unit_no'];
  for (const uField of unitFields) {
    const uVal = item[uField];
    if (uVal !== null && uVal !== undefined && uVal !== '—') {
      const uStr = normalizeSearchText(uVal);
      const cleanQ = q.replace(/^№\s*/, '');
      if (uStr.includes(cleanQ) || (qDigits && extractDigits(uStr).includes(qDigits))) return true;
    }
  }

  // 5. Contract number matching (e.g. 25601-2026-0003 or 0003)
  const contractFields = options.contractFields || ['contract_number', 'contractNumber', 'contract'];
  for (const cField of contractFields) {
    const cVal = item[cField];
    if (cVal) {
      const cStr = normalizeSearchText(cVal);
      if (cStr.includes(q)) return true;
      if (qDigits && extractDigits(cStr).includes(qDigits)) return true;
    }
  }

  // 6. INN matching
  const innFields = options.innFields || ['inn', 'clientInn', 'lead_inn'];
  for (const iField of innFields) {
    const iVal = item[iField];
    if (iVal) {
      const iStr = normalizeSearchText(iVal);
      if (iStr.includes(q)) return true;
    }
  }

  return false;
};
