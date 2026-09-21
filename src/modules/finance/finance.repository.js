import crypto from 'crypto';
import { getDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';

// Проверка идемпотентности напрямую в БД без использования in-memory кэша (для многопроцессной архитектуры)
async function checkIdempotentExpense(db, key) {
  if (!key) return null;
  try {
    const { data: existing, error } = await db.from('expenses')
      .select('*')
      .eq('idempotency_key', key)
      .maybeSingle();
    if (!error && existing) {
      return existing;
    }
  } catch {
    // В случае если колонка еще не в schema cache
  }

  // Поиск по персистентной метке в БД (гарантирует синхронизацию между независимыми экземплярами backend)
  try {
    const { data: matches, error: tagErr } = await db.from('expenses')
      .select('*')
      .ilike('description', `%[IDEMP:${key}]%`)
      .limit(1);
    if (!tagErr && matches && matches.length > 0) {
      return matches[0];
    }
  } catch {
    // Ошибки чтения игнорируются
  }

  return null;
}

// Реестр активных (in-flight) запросов на время выполнения вставки для предотвращения дублей при параллельных запросах
const inflightInserts = new Map();
const inflightExpenses = new Map();

// Сериализация операций по кассе на время проверки остатка и списания (защита от race condition до миграции 015)
const deskQueues = new Map();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCashDeskUuid(db, rawDesk) {
  if (!rawDesk) return null;
  const str = String(rawDesk).trim();
  if (UUID_REGEX.test(str)) {
    return str;
  }
  try {
    const { data: dictDesks } = await db.from('dictionaries')
      .select('id, code, name')
      .eq('type', 'CASH_DESK')
      .eq('is_active', true);
    if (dictDesks && dictDesks.length > 0) {
      const matched = dictDesks.find(d => 
        (d.code && d.code.toLowerCase() === str.toLowerCase()) ||
        (d.name && d.name.toLowerCase() === str.toLowerCase()) ||
        (d.id && d.id.toLowerCase() === str.toLowerCase())
      );
      if (matched) return matched.id;
    }
  } catch (err) {
    console.warn('Error resolving cash desk UUID:', err.message);
  }
  return null;
}
function withDeskLock(deskId, fn) {
  if (!deskId) return fn();
  const prev = deskQueues.get(deskId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  deskQueues.set(deskId, prev.then(() => current, () => current));
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
      if (deskQueues.get(deskId) === current) {
        deskQueues.delete(deskId);
      }
    }
  });
}

async function insertExpenseWithIdempotency(db, payload) {
  const key = payload.idempotency_key;
  if (key) {
    if (inflightInserts.has(key)) {
      const inflightResult = await inflightInserts.get(key);
      return { ...inflightResult, idempotent: true };
    }
    const existing = await checkIdempotentExpense(db, key);
    if (existing) {
      return { data: existing, error: null, idempotent: true };
    }
  }

  const executeInsert = async () => {
    const desc = (payload.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim();
    const cleanPayload = {
      ...payload,
      description: desc
    };

    const { idempotency_key, ...payloadWithoutCol } = cleanPayload;

    try {
      const res = await db.from('expenses').insert([cleanPayload]).select().single();
      if (res.error) {
        if (res.error.message && res.error.message.includes('idempotency_key') && res.error.message.includes('schema cache')) {
          const fallbackRes = await db.from('expenses').insert([payloadWithoutCol]).select().single();
          return fallbackRes;
        }
        if (res.error.code === '23505' || res.error.message?.includes('duplicate key') || res.error.message?.includes('idempotency_key')) {
          const existing = await checkIdempotentExpense(db, key);
          if (existing) {
            return { data: existing, error: null, idempotent: true };
          }
        }
      }
      return res;
    } catch (err) {
      if (key) {
        const existing = await checkIdempotentExpense(db, key);
        if (existing) {
          return { data: existing, error: null, idempotent: true };
        }
      }
      return await db.from('expenses').insert([payloadWithoutCol]).select().single();
    }
  };

  if (key) {
    const insertPromise = executeInsert();
    inflightInserts.set(key, insertPromise);
    try {
      return await insertPromise;
    } finally {
      inflightInserts.delete(key);
    }
  }

  return await executeInsert();
}

export class FinanceRepository {
  static async resolveCashDeskUuid(db, rawDesk) {
    return resolveCashDeskUuid(db, rawDesk);
  }

  /**
   * Определение динамического диапазона лет на основе данных в БД
   */
  static async getAvailableYears() {
    const db = getDB();
    const currentYear = new Date().getFullYear();
    let minYear = currentYear;
    let maxYear = currentYear;

    // 1. Deals dates
    const { data: deals } = await db.from('deals').select('deal_date, created_at');
    (deals || []).forEach(d => {
      const dateStr = d.deal_date || d.created_at;
      if (dateStr) {
        const y = new Date(dateStr).getFullYear();
        if (y && !isNaN(y) && y > 2000 && y < 2100) {
          minYear = Math.min(minYear, y);
          maxYear = Math.max(maxYear, y);
        }
      }
    });

    // 2. Installment schedules dates (могут быть на 2-5 лет вперед)
    const { data: schedules } = await db.from('deal_payment_schedules').select('due_date');
    (schedules || []).forEach(s => {
      if (s.due_date) {
        const y = new Date(s.due_date).getFullYear();
        if (y && !isNaN(y) && y > 2000 && y < 2100) {
          minYear = Math.min(minYear, y);
          maxYear = Math.max(maxYear, y);
        }
      }
    });

    // 3. Payments dates
    const { data: payments } = await db.from('payments').select('payment_date, created_at');
    (payments || []).forEach(p => {
      const dateStr = p.payment_date || p.created_at;
      if (dateStr) {
        const y = new Date(dateStr).getFullYear();
        if (y && !isNaN(y) && y > 2000 && y < 2100) {
          minYear = Math.min(minYear, y);
          maxYear = Math.max(maxYear, y);
        }
      }
    });

    // 4. Expenses dates
    const { data: expenses } = await db.from('expenses').select('expense_date');
    (expenses || []).forEach(e => {
      if (e.expense_date) {
        const y = new Date(e.expense_date).getFullYear();
        if (y && !isNaN(y) && y > 2000 && y < 2100) {
          minYear = Math.min(minYear, y);
          maxYear = Math.max(maxYear, y);
        }
      }
    });

    const years = [];
    for (let y = minYear; y <= maxYear; y++) {
      years.push(y);
    }
    return years;
  }

  /**
   * Получить список доходов (приходных ордеров и платежей)
   */
  static async getIncome(filters = {}, userAccess = null) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error } = await db.from('payments').select(`
      id, deal_id, schedule_id, amount_minor, currency, payment_date, method, reference, comment, payer_name, created_at,
      status, void_reason, voided_at, voided_by, transfer_id, conversion_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate,
      created_by_user_id,
      deals ( id, contract_number, currency, final_price_minor, deal_date, created_at, leads ( full_name, phone, inn ) ),
      users:created_by_user_id ( id, name )
    `).order('payment_date', { ascending: false });

    if (error) throw error;

    const allPayments = paymentsData || [];
    
    // Helper to extract tag from comment
    const extractTag = (text, tagName) => {
      if (!text) return null;
      const match = String(text).match(new RegExp(`\\[${tagName}:\\s*([^\\]]+)\\]`, 'i'));
      return match ? match[1].trim() : null;
    };

    // Normalize and extract currency for each payment
    let normalizedList = allPayments
      .filter(p => filters.include_voided ? true : p.status !== 'VOIDED')
      .map(p => {
        const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
        const amount = (p.amount_minor || 0) / 100;
        const isInv = p.operation_type === 'INVESTMENT' || (p.comment && p.comment.includes('Инвестиции партнёров'));
        const clientName = p.payer_name || p.deals?.leads?.full_name || (p.deal_id ? `Клиент по сделке #${p.deal_id}` : (isInv ? 'Инвестор' : 'Прямой плательщик'));
        const contract = isInv ? 'Инвестиция партнёра' : (p.deals?.contract_number || (p.deal_id ? `СД-${p.deal_id}` : 'Прямой приход'));
        const dealDate = p.deals?.deal_date || (p.deals?.created_at ? p.deals.created_at.split('T')[0] : null);
        const dealObj = p.deals ? {
          id: p.deals.id,
          contract_number: p.deals.contract_number,
          currency: p.deals.currency || 'USD',
          final_price: (p.deals.final_price_minor || 0) / 100,
          lead: p.deals.leads ? {
            name: p.deals.leads.full_name,
            phone: p.deals.leads.phone,
            inn: p.deals.leads.inn
          } : null
        } : null;

        const extractedCategory = extractTag(p.comment, 'Статья');
        const extractedBasis = extractTag(p.comment, 'Основание');
        const extractedPurpose = extractTag(p.comment, 'Назначение');

        return {
          id: p.id,
          dealId: p.deal_id,
          scheduleId: p.schedule_id,
          amount,
          currency: cur,
          date: p.payment_date,
          method: p.method || 'CASH',
          reference: p.reference || `ПКО-${p.id}`,
          comment: (p.comment || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').replace(/\[(Статья|Основание|Назначение):[^\]]+\]\s*/gi, '').trim(),
          payerName: p.payer_name || clientName,
          contract,
          dealDate,
          deal: dealObj,
          clientName,
          clientPhone: p.deals?.leads?.phone || '',
          clientInn: p.deals?.leads?.inn || '',
          status: p.status || 'ACTIVE',
          voidReason: p.void_reason || null,
          voidedAt: p.voided_at || null,
          transferId: p.transfer_id || null,
          cashDeskId: p.cash_desk_id || null,
          operationType: p.operation_type || 'STANDARD',
          amountTjs: p.amount_tjs ? Number(p.amount_tjs) : null,
          amountUsd: p.amount_usd ? Number(p.amount_usd) : null,
          exchangeRate: p.exchange_rate ? Number(p.exchange_rate) : null,
          projectId: isInv ? 3 : null,
          category: extractedCategory || (isInv ? 'Инвестиции партнёров' : null),
          basis: extractedBasis || null,
          purpose: extractedPurpose || null,
          createdByName: p.users?.name || 'Система',
          createdByUserId: p.created_by_user_id || p.users?.id || null,
          createdAt: p.created_at,
        };
      });

    // Серверная изоляция для менеджера: видит ПКО своей кассы ИЛИ оформленные лично им
    if (userAccess && !userAccess.isAdmin) {
      normalizedList = normalizedList.filter(item => {
        const belongsToUserDesk = (userAccess.viewableDeskIds && userAccess.viewableDeskIds.includes(item.cashDeskId)) || (userAccess.cashDeskId && item.cashDeskId === userAccess.cashDeskId);
        const createdByUser = userAccess.userId && Number(item.createdByUserId) === Number(userAccess.userId);
        return belongsToUserDesk || createdByUser;
      });
    } else if (filters.cash_desk_id) {
      normalizedList = normalizedList.filter(item => item.cashDeskId === filters.cash_desk_id);
    }

    // Currencies present
    const availableCurrencies = Array.from(new Set(normalizedList.map(item => item.currency)));
    if (!availableCurrencies.includes('USD')) availableCurrencies.push('USD');
    if (!availableCurrencies.includes('TJS')) availableCurrencies.push('TJS');

    // Totals by currency
    const isAllYears = filters.year === 'ALL';
    const totalsByCurrency = {};
    availableCurrencies.forEach(c => { totalsByCurrency[c] = 0; });
    normalizedList.forEach(item => {
      const pYear = item.date ? new Date(item.date).getFullYear() : null;
      if (isAllYears || pYear === currentYear) {
        totalsByCurrency[item.currency] = (totalsByCurrency[item.currency] || 0) + item.amount;
      }
    });

    // Filtered list for display
    let filteredList = normalizedList;
    if (!isAllYears) {
      filteredList = filteredList.filter(item => {
        if (!item.date) return false;
        const pYear = new Date(item.date).getFullYear();
        return pYear === currentYear;
      });
    }
    if (selectedCurrency) {
      filteredList = filteredList.filter(item => item.currency === selectedCurrency);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filteredList = filteredList.filter(item => 
        (item.clientName && item.clientName.toLowerCase().includes(q)) ||
        (item.contract && item.contract.toLowerCase().includes(q)) ||
        (item.reference && item.reference.toLowerCase().includes(q)) ||
        (item.comment && item.comment.toLowerCase().includes(q))
      );
    }

    // Monthly Chart Data
    const eskhataRate = 9.27;
    const chartCurrency = selectedCurrency || 'USD';
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    
    const monthlyIncome = Array(12).fill(0);
    normalizedList.forEach(item => {
      const d = new Date(item.date);
      if (d.getFullYear() === currentYear) {
        if (selectedCurrency && item.currency !== selectedCurrency) {
          return;
        }
        const isInternalTransfer = (item.reference && item.reference.includes('КОНВ')) || (item.payerName && item.payerName.includes('Касса') && item.payerName.includes('Автоконвертация'));
        if (!selectedCurrency && isInternalTransfer) {
          return;
        }
        let amt = item.amount;
        if (!selectedCurrency) {
          amt = item.currency === 'USD' ? item.amount : (item.amount / eskhataRate);
        }
        monthlyIncome[d.getMonth()] += amt;
      }
    });

    const chartData = monthNames.map((month, idx) => ({
      month,
      amount: Number(monthlyIncome[idx].toFixed(2)),
      currency: chartCurrency
    }));

    // Сортировка парных операций вместе
    const incGroups = new Map();
    filteredList.forEach(p => {
      const key = p.transferId ? ('transfer:' + p.transferId) : (p.conversion_id ? ('conversion:' + p.conversion_id) : ('single:' + p.id));
      if (!incGroups.has(key)) {
        incGroups.set(key, { key, items: [], maxDate: p.date, maxCreatedAt: p.createdAt });
      }
      const g = incGroups.get(key);
      g.items.push(p);
      if (new Date(p.date) > new Date(g.maxDate)) g.maxDate = p.date;
      if (new Date(p.createdAt) > new Date(g.maxCreatedAt)) g.maxCreatedAt = p.createdAt;
    });

    const sortedIncGroups = Array.from(incGroups.values()).sort((a, b) => {
      const dDiff = new Date(b.maxDate) - new Date(a.maxDate);
      if (dDiff !== 0) return dDiff;
      return new Date(b.maxCreatedAt) - new Date(a.maxCreatedAt);
    });

    const finalIncList = [];
    sortedIncGroups.forEach(g => {
      finalIncList.push(...g.items);
    });
    filteredList = finalIncList;

    return {
      list: filteredList,
      totals: totalsByCurrency,
      totalsByCurrency,
      availableCurrencies,
      availableYears,
      monthlyChart: chartData,
      chartData
    };
  }

  /**
   * Добавить приходный кассовый ордер (доход)
   */
  static async addIncome(data, userId, userAccess = null) {
    const db = getDB();
    const now = new Date().toISOString();
    if (data && data.amount !== undefined && data.amount !== null) {
      data.amount = String(data.amount).replace(',', '.').trim();
    }
    const amountMinor = Math.round(Number(data.amount) * 100);
    const paymentDate = data.date || data.payment_date || now.split('T')[0];
    const currency = (data.currency || 'USD').toUpperCase();
    let dealId = parseOptionalBigInt(data.deal_id);
    let scheduleId = parseOptionalBigInt(data.schedule_id);

    const settlementMethod = (data.settlement_method || 'CASH').toUpperCase();
    if (settlementMethod === 'INTERNAL_TRANSFER' || settlementMethod === 'CONVERSION') {
      const err = new Error('Внутренние перемещения и конвертации создаются через специальные разделы');
      err.statusCode = 400;
      throw err;
    }

    let rawTarget = (userAccess && !userAccess.isAdmin) 
      ? userAccess.cashDeskId 
      : (data.cash_desk_id !== undefined ? data.cash_desk_id : data.cash_desk);

    if (settlementMethod === 'CASH' && !rawTarget) {
      const err = new Error('Касса зачисления обязательна (cash_desk_id)');
      err.statusCode = 400;
      err.code = 'CASH_DESK_REQUIRED';
      throw err;
    }

    let targetCashDeskId = rawTarget ? await resolveCashDeskUuid(db, rawTarget) : null;
    if (settlementMethod === 'CASH' && !targetCashDeskId) {
      const err = new Error('Указанная касса зачисления не найдена или неактивна');
      err.statusCode = 400;
      err.code = 'CASH_DESK_REQUIRED';
      throw err;
    }

    // Check if target desk is TOZON_PLAZA_INVESTMENT or operation_type is INVESTMENT
    let isInvestment = data.operation_type === 'INVESTMENT' || data.is_investment;
    if (!isInvestment && targetCashDeskId) {
      const { data: deskObj } = await db.from('dictionaries').select('code').eq('id', targetCashDeskId).maybeSingle();
      if (deskObj && deskObj.code === 'TOZON_PLAZA_INVESTMENT') {
        isInvestment = true;
      }
    }

    let operationType = isInvestment ? 'INVESTMENT' : (data.operation_type || 'STANDARD');
    let payerName = data.payer_name || data.partner_name || data.partner || null;
    let category = data.category || (isInvestment ? 'Инвестиции партнёров' : null);
    let basis = data.basis || null;
    let purpose = data.purpose || null;
    let projectId = data.project_id ? parseOptionalBigInt(data.project_id) : (isInvestment ? 3 : null);

    let exchangeRate = data.exchange_rate ? Number(data.exchange_rate) : null;
    let amountUsd = data.amount_usd ? Number(data.amount_usd) : null;
    let amountTjs = data.amount_tjs ? Number(data.amount_tjs) : null;

    if (isInvestment) {
      dealId = null;
      scheduleId = null;
      if (!payerName || !String(payerName).trim()) {
        const err = new Error('Имя партнера/инвестора обязательно при оформлении инвестиционного ПКО');
        err.statusCode = 400;
        throw err;
      }

      if (currency === 'TJS') {
        if (!exchangeRate || exchangeRate <= 0) {
          const err = new Error('Курс обмена обязателен при внесении инвестиции в TJS');
          err.statusCode = 400;
          throw err;
        }
        amountTjs = Number(data.amount);
        amountUsd = Math.round((Number(data.amount) / exchangeRate) * 100) / 100;
      } else if (currency === 'USD') {
        amountUsd = Number(data.amount);
        if (exchangeRate && exchangeRate > 0) {
          amountTjs = Math.round(Number(data.amount) * exchangeRate * 100) / 100;
        }
      }
    }

    // Build comment with embedded tags for basis, purpose, category
    let commentParts = [];
    if (category && category !== 'Инвестиции партнёров') {
      commentParts.push(`[Статья: ${category.trim()}]`);
    }
    if (basis && basis.trim()) {
      commentParts.push(`[Основание: ${basis.trim()}]`);
    }
    if (purpose && purpose.trim()) {
      commentParts.push(`[Назначение: ${purpose.trim()}]`);
    }
    const cleanComm = (data.comment || '').replace(/\[(Статья|Основание|Назначение):[^\]]+\]\s*/gi, '').trim();
    if (cleanComm) {
      commentParts.push(cleanComm);
    }
    const fullComment = commentParts.join(' ').trim();

    const { data: newPayment, error } = await db.from('payments').insert([{
      deal_id: dealId,
      schedule_id: scheduleId,
      amount_minor: amountMinor,
      currency,
      payment_date: paymentDate,
      method: data.method || 'CASH',
      settlement_method: settlementMethod,
      reference: data.reference || `ПКО-${Date.now().toString().slice(-6)}`,
      comment: fullComment || null,
      payer_name: payerName,
      cash_desk_id: targetCashDeskId,
      operation_type: operationType,
      exchange_rate: exchangeRate,
      amount_usd: amountUsd,
      amount_tjs: amountTjs,
      created_by_user_id: parseOptionalBigInt(userId),
      created_at: now
    }]).select().single();

    if (error) throw error;

    // If tied to a schedule, update it
    if (scheduleId) {
      const { data: schedule } = await db.from('deal_payment_schedules').select('*').eq('id', scheduleId).single();
      if (schedule) {
        const newPaid = (schedule.paid_amount_minor || 0) + amountMinor;
        const newStatus = newPaid >= schedule.amount_minor ? 'PAID' : 'PARTIAL';
        await db.from('deal_payment_schedules').update({
          paid_amount_minor: newPaid,
          status: newStatus,
          updated_at: now
        }).eq('id', scheduleId);
      }
    }

    return newPayment;
  }

  /**
   * Обновить приходный ордер / платеж (только ADMIN)
   */
  static async updateIncome(id, data, userRole, userAccess = null) {
    if (userRole !== 'ADMIN' || (userAccess && !userAccess.isAdmin)) {
      throw new Error('Редактирование приходных кассовых ордеров запрещено для вашей роли');
    }
    const db = getDB();
    const now = new Date().toISOString();
    if (data && data.amount !== undefined && data.amount !== null) {
      data.amount = String(data.amount).replace(',', '.').trim();
    }

    const { data: originalRecord } = await db.from('payments').select('*').eq('id', id).maybeSingle();
    if (!originalRecord) {
      throw new Error('Документ не найден');
    }

    const isConversion = originalRecord.operation_type === 'CONVERSION' || Boolean(originalRecord.conversion_id);
    if (isConversion && data.amount !== undefined) {
      const newMinor = Math.round(Number(data.amount) * 100);
      if (newMinor !== originalRecord.amount_minor) {
        throw new Error('Изменение суммы валютообменного ордера запрещено. Сумма конвертации защищена от случайного изменения.');
      }
    }

    const updatePayload = {};
    if (data.amount !== undefined && !isConversion) {
      updatePayload.amount_minor = Math.round(Number(data.amount) * 100);
    }
    if (data.currency && !isConversion) updatePayload.currency = String(data.currency).toUpperCase();
    if (data.date || data.payment_date) updatePayload.payment_date = data.date || data.payment_date;
    if (data.method) updatePayload.method = data.method;
    if (data.reference !== undefined) updatePayload.reference = data.reference;
    if (data.comment !== undefined || data.description !== undefined) {
      updatePayload.comment = data.comment !== undefined ? data.comment : data.description;
    }
    if (data.payer_name !== undefined || data.recipient !== undefined || data.partner_name !== undefined) {
      updatePayload.payer_name = data.payer_name !== undefined ? data.payer_name : (data.partner_name !== undefined ? data.partner_name : data.recipient);
    }
    if (data.category !== undefined) updatePayload.category = data.category;
    if (data.basis !== undefined) updatePayload.basis = data.basis;
    if (data.purpose !== undefined) updatePayload.purpose = data.purpose;
    if (data.project_id !== undefined) updatePayload.project_id = parseOptionalBigInt(data.project_id);
    if (data.exchange_rate !== undefined) updatePayload.exchange_rate = data.exchange_rate ? Number(data.exchange_rate) : null;
    if (data.amount_usd !== undefined) updatePayload.amount_usd = data.amount_usd ? Number(data.amount_usd) : null;
    if (data.amount_tjs !== undefined) updatePayload.amount_tjs = data.amount_tjs ? Number(data.amount_tjs) : null;
    const rawDesk = data.cash_desk_id !== undefined ? data.cash_desk_id : data.cash_desk;
    if (rawDesk !== undefined) {
      if (rawDesk === null || rawDesk === '') {
        const err = new Error('Отвязка кассы (null) запрещена для активных финансовых документов');
        err.statusCode = 400;
        throw err;
      }
      const resolvedUuid = await resolveCashDeskUuid(db, rawDesk);
      if (resolvedUuid) {
        updatePayload.cash_desk_id = resolvedUuid;
      } else {
        const err = new Error('Указанная касса не найдена');
        err.statusCode = 400;
        throw err;
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return originalRecord;
    }

    const { data: updatedRows, error } = await db.from('payments').update(updatePayload).eq('id', id).select();
    if (error) {
      console.error('Error updating income in DB:', error);
      throw error;
    }

    const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;

    // Recalculate schedule if linked
    if (updated && updated.schedule_id) {
      const { data: schedPayments } = await db.from('payments').select('amount_minor').eq('schedule_id', updated.schedule_id);
      const totalPaid = (schedPayments || []).reduce((sum, p) => sum + (p.amount_minor || 0), 0);
      const { data: schedule } = await db.from('deal_payment_schedules').select('amount_minor').eq('id', updated.schedule_id).single();
      if (schedule) {
        const newStatus = totalPaid >= schedule.amount_minor ? 'PAID' : totalPaid > 0 ? 'PARTIAL' : 'PENDING';
        await db.from('deal_payment_schedules').update({ paid_amount_minor: totalPaid, status: newStatus, updated_at: now }).eq('id', updated.schedule_id);
      }
    }

    // Sync paired conversion expense if this was a conversion
    if (originalRecord) {
      await this.syncPairedConversion('INCOME', originalRecord, data);
    }

    return updated || { success: true };
  }

  /**
   * Получить актуальный баланс конкретной кассы (в USD)
   */
  /**
   * Получить актуальный баланс конкретной кассы (в USD, только физические деньги)
   */
  static async getCashDeskBalance(cashDeskId) {
    if (!cashDeskId) return 0;
    const db = getDB();
    const PROVEN_BARTER_PKO_IDS = [94, 96, 98];
    const PROVEN_BARTER_RKO_IDS = [165, 167, 169];

    const { data: pData } = await db.from('payments')
      .select('id, amount_minor, currency, settlement_method')
      .eq('cash_desk_id', cashDeskId)
      .neq('status', 'VOIDED');

    const { data: eData } = await db.from('expenses')
      .select('id, amount_minor, currency, settlement_method')
      .eq('cash_desk_id', cashDeskId)
      .neq('status', 'VOIDED');

    let balanceUsd = 0;
    (pData || []).forEach(p => {
      const sm = p.settlement_method || (PROVEN_BARTER_PKO_IDS.includes(p.id) ? 'NON_CASH_BARTER' : 'CASH');
      if (sm === 'NON_CASH_BARTER' || sm === 'BANK') return;
      const cur = (p.currency || 'USD').toUpperCase();
      if (cur === 'USD') balanceUsd += (p.amount_minor || 0) / 100;
    });
    (eData || []).forEach(e => {
      const sm = e.settlement_method || (PROVEN_BARTER_RKO_IDS.includes(e.id) ? 'NON_CASH_BARTER' : 'CASH');
      if (sm === 'NON_CASH_BARTER' || sm === 'BANK') return;
      const cur = (e.currency || 'USD').toUpperCase();
      if (cur === 'USD') balanceUsd -= (e.amount_minor || 0) / 100;
    });
    return Number(balanceUsd.toFixed(2));
  }

  /**
   * Получить ПКО по ID с проверкой прав доступа к кассе
   */
  static async getIncomeById(id, userAccess = null) {
    const db = getDB();
    const { data: payment, error } = await db.from('payments').select(`
      *,
      deals ( id, contract_number, currency, deal_date, created_at, leads ( full_name, inn, phone ) ),
      users:created_by_user_id ( name )
    `).eq('id', id).maybeSingle();

    if (error || !payment) {
      const err = new Error('Документ ПКО не найден');
      err.statusCode = 404;
      throw err;
    }

    if (userAccess && !userAccess.isAdmin) {
      const belongsToUserDesk = (userAccess.viewableDeskIds && userAccess.viewableDeskIds.includes(payment.cash_desk_id)) || (userAccess.cashDeskId && payment.cash_desk_id === userAccess.cashDeskId);
      const createdByUser = userAccess.userId && Number(payment.created_by_user_id) === Number(userAccess.userId);
      if (!belongsToUserDesk && !createdByUser) {
        const err = new Error('Документ не найден');
        err.statusCode = 404;
        throw err;
      }
    }

    return payment;
  }

  /**
   * Получить РКО по ID с проверкой прав доступа к кассе
   */
  static async getExpenseById(id, userAccess = null) {
    const db = getDB();
    const { data: expense, error } = await db.from('expenses').select(`
      *,
      users:created_by_user_id ( name )
    `).eq('id', id).maybeSingle();

    if (error || !expense) {
      const err = new Error('Документ РКО не найден');
      err.statusCode = 404;
      throw err;
    }

    if (userAccess && !userAccess.isAdmin) {
      if (expense.cash_desk_id !== userAccess.cashDeskId) {
        const err = new Error('Документ не найден');
        err.statusCode = 404;
        throw err;
      }
    }

    if (expense) {
      const amt = (expense.amount_minor || 0) / 100;
      const cur = (expense.currency || 'USD').toUpperCase();
      let cleanDesc = (expense.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim();
      if ((expense.category === 'Конвертация валюты' || expense.operation_type === 'CONVERSION' || expense.reference?.startsWith('КОНВ-')) && cleanDesc.toLowerCase().startsWith('обмен')) {
        const rateMatch = cleanDesc.match(/курсу\s*([\d\.,]+)/i);
        const rate = rateMatch ? rateMatch[1] : (expense.exchange_rate || '9.27');
        cleanDesc = `Обмен ${amt.toFixed(2)} ${cur} в TJS по курсу ${rate}`;
      }
      expense.description = cleanDesc;
    }

    return expense;
  }

  /**
   * Удалить приходный ордер / платеж (только ADMIN)
   */
  static async deleteIncome(id, userRole, userAccess = null) {
    if (userRole !== 'ADMIN' || (userAccess && !userAccess.isAdmin)) {
      throw new Error('Удаление приходных кассовых ордеров запрещено для вашей роли');
    }
    const db = getDB();
    const now = new Date().toISOString();

    const { data: payment, error: getErr } = await db.from('payments').select('*').eq('id', id).maybeSingle();
    if (getErr || !payment) {
      await db.from('payments').delete().eq('id', id);
      return { success: true };
    }

    const scheduleId = payment.schedule_id;
    const { error } = await db.from('payments').delete().eq('id', id);
    if (error) throw error;

    // Recalculate schedule if linked
    if (scheduleId) {
      const { data: schedPayments } = await db.from('payments').select('amount_minor').eq('schedule_id', scheduleId);
      const totalPaid = (schedPayments || []).reduce((sum, p) => sum + (p.amount_minor || 0), 0);
      const { data: schedule } = await db.from('deal_payment_schedules').select('amount_minor').eq('id', scheduleId).maybeSingle();
      if (schedule) {
        const newStatus = totalPaid >= schedule.amount_minor ? 'PAID' : totalPaid > 0 ? 'PARTIAL' : 'PENDING';
        await db.from('deal_payment_schedules').update({ paid_amount_minor: totalPaid, status: newStatus, updated_at: now }).eq('id', scheduleId);
      }
    }

    // Delete paired conversion expense
    await this.deletePairedConversion('INCOME', payment);

    return { success: true };
  }

  /**
   * Вспомогательный метод для единого расчета USD-эквивалента финансовой операции
   */
  static calculateItemUsdAmount(item, defaultRate = 9.27) {
    if (!item) return 0;
    if (item.currency === 'USD') {
      return Number(item.amount) || 0;
    }
    if (item.amount_usd && Number(item.amount_usd) > 0) {
      return Number(item.amount_usd);
    }
    if (item.exchange_rate && Number(item.exchange_rate) > 0) {
      return Number((Number(item.amount) / Number(item.exchange_rate)).toFixed(2));
    }
    return Number((Number(item.amount) / defaultRate).toFixed(2));
  }

  /**
   * Получить список расходов (расходных ордеров)
   */
  static async getExpenses(filters = {}, userAccess = null) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: expensesData, error } = await db.from('expenses').select(`
      id, amount_minor, currency, expense_date, category, method, reference, recipient, description, created_at,
      exchange_rate, amount_usd, conversion_expense_id,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type,
      users:created_by_user_id ( id, name )
    `).order('expense_date', { ascending: false });

    if (error) throw error;

    const allExpenses = expensesData || [];
    
    let normalizedList = allExpenses
      .filter(e => filters.include_voided ? true : e.status !== 'VOIDED')
      .map(e => {
        const cur = (e.currency || 'USD').toUpperCase();
        const amount = (e.amount_minor || 0) / 100;

        let cleanDesc = (e.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim();
        if ((e.category === 'Конвертация валюты' || e.operation_type === 'CONVERSION' || e.reference?.startsWith('КОНВ-')) && cleanDesc.toLowerCase().startsWith('обмен')) {
          const rateMatch = cleanDesc.match(/курсу\s*([\d\.,]+)/i);
          const rate = rateMatch ? rateMatch[1] : (e.exchange_rate || '9.27');
          cleanDesc = `Обмен ${amount.toFixed(2)} ${cur} в TJS по курсу ${rate}`;
        }

        return {
          id: e.id,
          amount,
          currency: cur,
          date: e.expense_date,
          category: e.category || 'Прочее',
          method: e.method || 'CASH',
          reference: e.reference || `РКО-${e.id}`,
          recipient: e.recipient || 'Контрагент',
          description: cleanDesc,
          exchange_rate: e.exchange_rate ? Number(e.exchange_rate) : null,
          amount_usd: e.amount_usd ? Number(e.amount_usd) : null,
          conversion_expense_id: e.conversion_expense_id || null,
          status: e.status || 'ACTIVE',
          voidReason: e.void_reason || null,
          voidedAt: e.voided_at || null,
          transferId: e.transfer_id || null,
          cashDeskId: e.cash_desk_id || null,
          operationType: e.operation_type || 'STANDARD',
          createdByName: e.users?.name || 'Администратор',
          createdAt: e.created_at
        };
      });

    // Строгая серверная изоляция для менеджера
    if (userAccess && !userAccess.isAdmin) {
      normalizedList = normalizedList.filter(item => item.cashDeskId === userAccess.cashDeskId);
    } else if (filters.cash_desk_id) {
      normalizedList = normalizedList.filter(item => item.cashDeskId === filters.cash_desk_id);
    }

    const availableCurrencies = Array.from(new Set(normalizedList.map(item => item.currency)));
    if (!availableCurrencies.includes('USD')) availableCurrencies.push('USD');
    if (!availableCurrencies.includes('TJS')) availableCurrencies.push('TJS');

    const isAllYears = filters.year === 'ALL';
    const eskhataRate = 9.27;

    // Исключаем технические ордера автоконвертации (КОНВ-*) из операционных расходов
    const operationalItems = normalizedList.filter(item => {
      const eYear = item.date ? new Date(item.date).getFullYear() : null;
      if (!isAllYears && eYear !== currentYear) return false;
      
      const isInternalTransfer = item.category === 'Конвертация валюты' || 
        (item.recipient && item.recipient.includes('Касса') && item.recipient.includes('Автоконвертация')) ||
        (item.reference && item.reference.startsWith('КОНВ-'));
      return !isInternalTransfer;
    });

    // Totals by currency с единым расчетом USD-эквивалента
    const totalsByCurrency = { USD: 0, TJS: 0, RUB: 0 };
    operationalItems.forEach(item => {
      totalsByCurrency.USD = Number((totalsByCurrency.USD + this.calculateItemUsdAmount(item, eskhataRate)).toFixed(2));
      if (item.currency === 'TJS') {
        totalsByCurrency.TJS = Number((totalsByCurrency.TJS + item.amount).toFixed(2));
      } else if (item.currency === 'RUB') {
        totalsByCurrency.RUB = Number(((totalsByCurrency.RUB || 0) + item.amount).toFixed(2));
      }
    });

    // Filtered list
    let filteredList = normalizedList;
    if (!isAllYears) {
      filteredList = filteredList.filter(item => {
        if (!item.date) return false;
        const eYear = new Date(item.date).getFullYear();
        return eYear === currentYear;
      });
    }
    if (selectedCurrency) {
      filteredList = filteredList.filter(item => item.currency === selectedCurrency);
    }
    if (filters.category && filters.category !== 'ALL') {
      filteredList = filteredList.filter(item => item.category === filters.category);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filteredList = filteredList.filter(item => 
        (item.recipient && item.recipient.toLowerCase().includes(q)) ||
        (item.category && item.category.toLowerCase().includes(q)) ||
        (item.reference && item.reference.toLowerCase().includes(q)) ||
        (item.description && item.description.toLowerCase().includes(q))
      );
    }

    // Categories Breakdown Chart
    const chartCurrency = selectedCurrency || 'USD';
    const categoryTotals = {};
    const categoryCurrencies = {};

    operationalItems.forEach(item => {
      if (selectedCurrency && item.currency !== selectedCurrency) {
        return;
      }

      const cat = item.category || 'Прочее';
      let amountInChartCur = item.amount;
      if (!selectedCurrency) {
        amountInChartCur = this.calculateItemUsdAmount(item, eskhataRate);
      }

      categoryTotals[cat] = (categoryTotals[cat] || 0) + amountInChartCur;
      if (!categoryCurrencies[cat]) categoryCurrencies[cat] = {};
      categoryCurrencies[cat][item.currency] = (categoryCurrencies[cat][item.currency] || 0) + item.amount;
    });

    const categoriesChart = Object.keys(categoryTotals).map(cat => ({
      name: cat,
      amount: Number(categoryTotals[cat].toFixed(2)),
      breakdown: categoryCurrencies[cat]
    }));

    // Сортировка парных операций (КОНВ и РКО) строго вместе
    const convExpIdMap = new Map();
    filteredList.forEach(e => {
      if (e.conversion_expense_id) {
        convExpIdMap.set(e.conversion_expense_id, e.id);
        convExpIdMap.set(e.id, e.conversion_expense_id);
      }
    });

    const getExpGroupKey = (e) => {
      if (e.transferId) return 'transfer:' + e.transferId;
      if (e.conversion_id) return 'conversion:' + e.conversion_id;
      if (e.conversion_expense_id) return 'conv_exp:' + e.conversion_expense_id;
      if (convExpIdMap.has(e.id)) return 'conv_exp:' + e.id;
      return 'single:' + e.id;
    };

    const expGroups = new Map();
    filteredList.forEach(e => {
      let key = getExpGroupKey(e);
      if (!expGroups.has(key)) {
        expGroups.set(key, { key, items: [], maxDate: e.date, maxCreatedAt: e.createdAt });
      }
      const g = expGroups.get(key);
      g.items.push(e);
      if (new Date(e.date) > new Date(g.maxDate)) g.maxDate = e.date;
      if (new Date(e.createdAt) > new Date(g.maxCreatedAt)) g.maxCreatedAt = e.createdAt;
    });

    const sortedExpGroups = Array.from(expGroups.values()).sort((a, b) => {
      const dDiff = new Date(b.maxDate) - new Date(a.maxDate);
      if (dDiff !== 0) return dDiff;
      return new Date(b.maxCreatedAt) - new Date(a.maxCreatedAt);
    });

    const finalExpList = [];
    sortedExpGroups.forEach(g => {
      g.items.sort((a, b) => {
        const aIsConv = a.category === 'Конвертация валюты' || a.reference?.startsWith('КОНВ-') ? 1 : 2;
        const bIsConv = b.category === 'Конвертация валюты' || b.reference?.startsWith('КОНВ-') ? 1 : 2;
        return aIsConv - bIsConv;
      });
      finalExpList.push(...g.items);
    });
    filteredList = finalExpList;

    return {
      list: filteredList,
      totals: totalsByCurrency,
      totalsByCurrency,
      availableCurrencies,
      availableYears,
      categoriesChart,
      chartCurrency
    };
  }

  /**
   * Добавить расходный кассовый ордер (с поддержкой автоконвертации и контролем остатка)
   */
  static async addExpense(data, userId, userAccess = null) {
    if (data && data.amount !== undefined && data.amount !== null) {
      data.amount = String(data.amount).replace(',', '.').trim();
    }
    const key = data.idempotency_key ? String(data.idempotency_key).trim() : null;
    if (key && inflightExpenses.has(key)) {
      const inflightResult = await inflightExpenses.get(key);
      return { ...inflightResult, idempotent: true };
    }

    const runAddExpense = async () => {
      const db = getDB();
      const settlementMethod = (data.settlement_method || 'CASH').toUpperCase();
      if (settlementMethod === 'INTERNAL_TRANSFER' || settlementMethod === 'CONVERSION') {
        const err = new Error('Внутренние перемещения и конвертации создаются через специальные разделы');
        err.statusCode = 400;
        throw err;
      }

      let rawTarget = (userAccess && !userAccess.isAdmin)
        ? userAccess.cashDeskId
        : (data.cash_desk_id !== undefined ? data.cash_desk_id : data.cash_desk);

      if (settlementMethod === 'CASH' && !rawTarget) {
        const err = new Error('Касса списания обязательна (cash_desk_id)');
        err.statusCode = 400;
        err.code = 'CASH_DESK_REQUIRED';
        throw err;
      }

      let targetCashDeskId = rawTarget ? await resolveCashDeskUuid(db, rawTarget) : null;
      if (settlementMethod === 'CASH' && !targetCashDeskId) {
        const err = new Error('Указанная касса списания не найдена или неактивна');
        err.statusCode = 400;
        err.code = 'CASH_DESK_REQUIRED';
        throw err;
      }

      // 1. Проверка в БД: если операция уже существует (между процессами)
      if (key) {
        const existing = await checkIdempotentExpense(db, key);
        if (existing) {
          return {
            id: existing.id,
            reference: existing.reference || `РКО-${existing.id}`,
            amount: (existing.amount_minor || 0) / 100,
            currency: existing.currency,
            cash_desk_id: existing.cash_desk_id,
            idempotent: true
          };
        }
      }

      const now = new Date().toISOString();
      const expenseDate = data.date || data.expense_date || now.split('T')[0];
      const currency = (data.currency || 'USD').toUpperCase();
      const exchangeRate = Number(data.exchange_rate) || 9.27;
      const isTransfer = data.category === 'Внутренние перемещения между кассами' || Boolean(data.is_transfer);

      // 2. Для менеджера: попытка вызова атомарной PostgreSQL-функции create_atomic_expense
      if (userAccess && !userAccess.isAdmin) {
        try {
          const rpcParams = {
            p_cash_desk_id: targetCashDeskId,
            p_amount_minor: Math.round(Number(data.amount) * 100),
            p_currency: currency,
            p_expense_date: expenseDate,
            p_category: data.category || 'Прочее',
            p_recipient: data.recipient || 'Контрагент',
            p_description: data.description || '',
            p_user_id: parseOptionalBigInt(userId),
            p_method: data.method || 'CASH',
            p_exchange_rate: exchangeRate,
            p_amount_usd: currency === 'USD' ? Number(data.amount) : Number((Number(data.amount) / exchangeRate).toFixed(2)),
            p_amount_tjs: currency === 'TJS' ? Number(data.amount) : null,
            p_idempotency_key: key
          };

          const { data: rpcResult, error: rpcError } = await db.rpc('create_atomic_expense', rpcParams);
          if (!rpcError && rpcResult) {
            return {
              id: rpcResult.expense_id,
              reference: rpcResult.reference,
              amount: rpcResult.amount,
              currency: rpcResult.currency,
              cash_desk_id: rpcResult.cash_desk_id,
              idempotent: rpcResult.idempotent,
              balance_after: rpcResult.balance_after
            };
          }
        } catch {
          // Игнорируем ошибку отсутствия функции до миграции
        }

        // Контроль остатка кассы для менеджера (запрет отрицательного сальдо)
        const currentBalanceUsd = await this.getCashDeskBalance(userAccess.cashDeskId);
        const requestedUsd = (currency === 'TJS') 
          ? Number((Number(data.amount) / exchangeRate).toFixed(2)) 
          : Number(data.amount);

        if (requestedUsd > currentBalanceUsd) {
          throw new Error(`Недостаточно средств в кассе менеджера. Доступный остаток: $${currentBalanceUsd.toFixed(2)} USD, запрошено: $${requestedUsd.toFixed(2)} USD`);
        }
      }

      // Поддержка явной автоконвертации с созданием связки расходов
      if (data.auto_convert && currency !== (data.source_currency || 'USD')) {
        const sourceCurrency = (data.source_currency || 'USD').toUpperCase();
        const convertedSourceAmount = Number((Number(data.amount) / exchangeRate).toFixed(2));
        const sourceMinor = Math.round(convertedSourceAmount * 100);
        const autoConversionId = crypto.randomUUID();

        const { data: convExpense } = await db.from('expenses').insert([{
          amount_minor: sourceMinor,
          currency: sourceCurrency,
          expense_date: expenseDate,
          category: 'Конвертация валюты',
          method: data.method || 'CASH',
          reference: 'TEMP_REF',
          recipient: `Касса ${currency} (Автоконвертация)`,
          description: `Автоконвертация $${convertedSourceAmount.toFixed(2)} ${sourceCurrency} по курсу ${exchangeRate} в ${currency} для расхода: ${data.description || data.category || data.recipient || 'РКО'}`,
          cash_desk_id: targetCashDeskId,
          created_by_user_id: parseOptionalBigInt(userId),
          conversion_id: autoConversionId,
          created_at: now
        }]).select().single();

        const convExpenseId = convExpense?.id || null;
        if (convExpenseId) {
          await db.from('expenses').update({ reference: `КОНВ-${convExpenseId}` }).eq('id', convExpenseId);
        }

        const { data: convPayment } = await db.from('payments').insert([{
          amount_minor: Math.round(Number(data.amount) * 100),
          currency: currency,
          payment_date: expenseDate,
          method: data.method || 'CASH',
          reference: 'TEMP_REF',
          payer_name: `Касса ${sourceCurrency} (Автоконвертация)`,
          comment: `Поступление от автоконвертации $${convertedSourceAmount.toFixed(2)} ${sourceCurrency} по курсу ${exchangeRate} для расхода: ${data.description || data.category || data.recipient || 'РКО'}`,
          cash_desk_id: targetCashDeskId,
          created_by_user_id: parseOptionalBigInt(userId),
          conversion_id: autoConversionId,
          created_at: now
        }]).select().single();

        if (convPayment?.id) {
          await db.from('payments').update({ reference: `ПКО-КОНВ-${convPayment.id}` }).eq('id', convPayment.id);
        }

        const { data: newExpense, error } = await insertExpenseWithIdempotency(db, {
          amount_minor: Math.round(Number(data.amount) * 100),
          currency,
          expense_date: expenseDate,
          category: data.category || 'Прочее',
          method: data.method || 'CASH',
          reference: data.reference || 'TEMP_REF',
          recipient: data.recipient || null,
          description: data.description || null,
          exchange_rate: exchangeRate,
          amount_usd: convertedSourceAmount,
          conversion_expense_id: convExpenseId,
          conversion_id: autoConversionId,
          cash_desk_id: targetCashDeskId,
          created_by_user_id: parseOptionalBigInt(userId),
          idempotency_key: key,
          created_at: now
        });

        if (error) throw error;
        const finalRef = data.reference || `РКО-${newExpense.id}`;
        await db.from('expenses').update({ reference: finalRef }).eq('id', newExpense.id);
        newExpense.reference = finalRef;
        newExpense.conversion = {
          has_conversion: true,
          conv_expense_id: convExpenseId,
          conv_expense_reference: `КОНВ-${convExpenseId}`,
          conv_payment_id: convPayment?.id || null,
          conv_payment_reference: convPayment?.id ? `ПКО-КОНВ-${convPayment.id}` : null,
          main_expense_id: newExpense.id,
          main_expense_reference: finalRef,
          source_currency: sourceCurrency,
          source_amount_usd: convertedSourceAmount,
          target_currency: currency,
          target_amount_tjs: Number(data.amount),
          exchange_rate: exchangeRate,
          recipient: data.recipient || 'Контрагент',
          category: data.category || 'Прочее',
          description: (data.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim(),
          cash_desk_id: targetCashDeskId
        };
        return newExpense;
      }

      // Защита от отрицательного сальдо при мультивалютных операциях
      if (currency === 'TJS') {
        const convertedUsd = Number((Number(data.amount) / exchangeRate).toFixed(2));
        const sourceMinor = Math.round(convertedUsd * 100);
        const originalTjsText = `${data.amount} TJS (Курс: ${exchangeRate})`;
        const descWithTjs = data.description ? `${data.description} • ${originalTjsText}` : originalTjsText;

        const { data: newExpense, error } = await insertExpenseWithIdempotency(db, {
          amount_minor: sourceMinor,
          currency: 'USD',
          expense_date: expenseDate,
          category: data.category || 'Прочее',
          method: data.method || 'CASH',
          reference: data.reference || 'TEMP_REF',
          recipient: data.recipient || null,
          description: descWithTjs,
          exchange_rate: exchangeRate,
          amount_usd: convertedUsd,
          conversion_expense_id: null,
          cash_desk_id: targetCashDeskId,
          created_by_user_id: parseOptionalBigInt(userId),
          idempotency_key: key,
          created_at: now
        });

        if (error) throw error;
        const finalRef = data.reference || `РКО-${newExpense.id}`;
        await db.from('expenses').update({ reference: finalRef }).eq('id', newExpense.id);
        newExpense.reference = finalRef;
        newExpense.conversion = {
          has_conversion: true,
          main_expense_id: newExpense.id,
          main_expense_reference: finalRef,
          source_currency: 'USD',
          source_amount_usd: convertedUsd,
          target_currency: 'TJS',
          target_amount_tjs: Number(data.amount),
          exchange_rate: exchangeRate,
          recipient: data.recipient || 'Контрагент',
          category: data.category || 'Прочее',
          description: (data.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim(),
          cash_desk_id: targetCashDeskId
        };
        return newExpense;
      }

      // Расход в USD (или иной базовой валюте)
      const amountMinor = Math.round(Number(data.amount) * 100);
      const { data: newExpense, error } = await insertExpenseWithIdempotency(db, {
        amount_minor: amountMinor,
        currency,
        expense_date: expenseDate,
        category: data.category || 'Прочее',
        method: data.method || 'CASH',
        reference: data.reference || 'TEMP_REF',
        recipient: data.recipient || null,
        description: data.description || null,
        exchange_rate: data.exchange_rate ? Number(data.exchange_rate) : null,
        amount_usd: data.amount_usd ? Number(data.amount_usd) : null,
        conversion_expense_id: null,
        cash_desk_id: targetCashDeskId,
        created_by_user_id: parseOptionalBigInt(userId),
        idempotency_key: key,
        created_at: now
      });

      if (error) throw error;
      const finalRef = data.reference || `РКО-${newExpense.id}`;
      await db.from('expenses').update({ reference: finalRef }).eq('id', newExpense.id);
      newExpense.reference = finalRef;

      // Атомарность перемещений: автоматически формировать парный приход на счёт-получатель
      if (isTransfer) {
        const targetDesk = data.recipient || data.target_desk || 'Касса компании "Тозон" (Илхомчон)';
        const sourceDesk = data.source_desk || 'Касса Отдела продаж (Акмалхон)';
        const pkoRef = `ПКО-ПЕРЕМ-${newExpense.id}`;

        await db.from('payments').insert([{
          amount_minor: amountMinor,
          currency: currency,
          payment_date: expenseDate,
          method: data.method || 'CASH',
          reference: pkoRef,
          payer_name: sourceDesk,
          comment: `[Касса: ${targetDesk}] Внутреннее перемещение из: ${sourceDesk} • ${data.description || ''}`,
          created_by_user_id: parseOptionalBigInt(userId),
          created_at: now
        }]);
      }

      return newExpense;
    };

    const targetDeskId = (userAccess && !userAccess.isAdmin)
      ? userAccess.cashDeskId
      : (data.cash_desk_id || null);

    const executeOperation = () => withDeskLock(targetDeskId, runAddExpense);

    if (key) {
      const expensePromise = executeOperation();
      inflightExpenses.set(key, expensePromise);
      try {
        return await expensePromise;
      } finally {
        inflightExpenses.delete(key);
      }
    }

    return await executeOperation();
  }

  /**
   * Обновить расходный ордер (только ADMIN)
   */
  static async updateExpense(id, data, userRole, userAccess = null) {
    if (userRole !== 'ADMIN' || (userAccess && !userAccess.isAdmin)) {
      throw new Error('Редактирование расходных кассовых ордеров запрещено для вашей роли');
    }
    const db = getDB();
    if (data && data.amount !== undefined && data.amount !== null) {
      data.amount = String(data.amount).replace(',', '.').trim();
    }

    const { data: originalRecord } = await db.from('expenses').select('*').eq('id', id).maybeSingle();
    if (!originalRecord) {
      throw new Error('Документ не найден');
    }

    const isConversion = originalRecord.operation_type === 'CONVERSION' || Boolean(originalRecord.conversion_id);
    if (isConversion && data.amount !== undefined) {
      const newMinor = Math.round(Number(data.amount) * 100);
      if (newMinor !== originalRecord.amount_minor) {
        throw new Error('Изменение суммы валютообменного ордера запрещено. Сумма конвертации защищена от случайного изменения.');
      }
    }

    const updatePayload = {};
    if (data.amount !== undefined && !isConversion) {
      updatePayload.amount_minor = Math.round(Number(data.amount) * 100);
    }
    if (data.currency && !isConversion) updatePayload.currency = String(data.currency).toUpperCase();
    if (data.date || data.expense_date) updatePayload.expense_date = data.date || data.expense_date;
    if (data.category) updatePayload.category = data.category;
    if (data.method) updatePayload.method = data.method;
    if (data.recipient !== undefined) updatePayload.recipient = data.recipient;
    if (data.reference !== undefined) updatePayload.reference = data.reference;
    if (data.description !== undefined || data.comment !== undefined) {
      updatePayload.description = data.description !== undefined ? data.description : data.comment;
    }
    const rawDesk = data.cash_desk_id !== undefined ? data.cash_desk_id : data.cash_desk;
    if (rawDesk !== undefined) {
      if (rawDesk === null || rawDesk === '') {
        const err = new Error('Отвязка кассы (null) запрещена для активных финансовых документов');
        err.statusCode = 400;
        throw err;
      }
      const resolvedUuid = await resolveCashDeskUuid(db, rawDesk);
      if (resolvedUuid) {
        updatePayload.cash_desk_id = resolvedUuid;
      } else {
        const err = new Error('Указанная касса не найдена');
        err.statusCode = 400;
        throw err;
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return originalRecord;
    }

    const { data: updatedRows, error } = await db.from('expenses').update(updatePayload).eq('id', id).select();
    if (error) {
      console.error('Error updating expense in DB:', error);
      throw error;
    }
    const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;

    // Sync paired conversion income in payments table
    if (originalRecord) {
      await this.syncPairedConversion('EXPENSE', originalRecord, data);
    }

    return updated || { success: true };
  }

  /**
   * Удалить расходный ордер (только ADMIN)
   */
  static async deleteExpense(id, userRole, userAccess = null) {
    if (userRole !== 'ADMIN' || (userAccess && !userAccess.isAdmin)) {
      throw new Error('Удаление расходных кассовых ордеров запрещено для вашей роли');
    }
    const db = getDB();
    const { data: originalRecord } = await db.from('expenses').select('*').eq('id', id).maybeSingle();
    const { error } = await db.from('expenses').delete().eq('id', id);
    if (error) {
      console.error('Error deleting expense in DB:', error);
      throw error;
    }

    // Delete paired conversion income
    if (originalRecord) {
      await this.deletePairedConversion('EXPENSE', originalRecord);
    }

    return { success: true };
  }

  /**
   * Синхронизация парной операции конвертации (Expense <-> Income)
   */
  static async syncPairedConversion(type, originalRecord, updatedData) {
    try {
      const db = getDB();
      if (!originalRecord) return;

      const isExp = type === 'EXPENSE';
      const ref = originalRecord.reference || '';
      const desc = (isExp ? originalRecord.description : originalRecord.comment) || '';
      const isConv = (originalRecord.category === 'Конвертация валюты') ||
                     (originalRecord.operation_type === 'CONVERSION') ||
                     Boolean(originalRecord.conversion_id) ||
                     ref.includes('КОНВ') || ref.includes('ОБМЕН') ||
                     desc.toLowerCase().includes('обмен') || desc.toLowerCase().includes('конвертаци');

      if (!isConv) return;

      // CRITICAL GUARD: Only sync amount if explicitly provided and actually changed!
      // If user only changed cash desk, date, or comment, NEVER mutate paired amount!
      const shouldSyncAmount = updatedData.amount !== undefined && 
                               Math.round(Number(updatedData.amount) * 100) !== originalRecord.amount_minor;

      const newDate = updatedData.date || updatedData.expense_date || updatedData.payment_date;

      // If neither amount nor date changed, DO NOT TOUCH paired record!
      if (!shouldSyncAmount && !newDate) {
        return;
      }

      // Extract exchange rate from description/comment or default to 10.90
      let rate = 10.90;
      const rateMatch = desc.match(/курсу\s*([\d\.,]+)/i);
      if (rateMatch && rateMatch[1]) {
        rate = parseFloat(rateMatch[1].replace(',', '.'));
      }

      const newAmount = shouldSyncAmount ? Number(updatedData.amount) : ((originalRecord.amount_minor || 0) / 100);
      const targetDate = newDate || originalRecord.expense_date || originalRecord.payment_date;
      const refSuffix = ref.replace(/^(ПКО-|ОБМЕН-|КОНВ-)/, '');

      if (isExp) {
        // Find paired payment strictly by conversion_id or exact refSuffix
        let paired = [];
        if (originalRecord.conversion_id) {
          const { data } = await db.from('payments').select('*').eq('conversion_id', originalRecord.conversion_id);
          paired = data || [];
        } else if (refSuffix) {
          const { data } = await db.from('payments').select('*').in('reference', [`ПКО-${refSuffix}`, `КОНВ-${refSuffix}`, `ОБМЕН-${refSuffix}`]);
          paired = data || [];
        }

        for (const p of paired) {
          const updateObj = {};
          if (newDate) updateObj.payment_date = targetDate;
          if (shouldSyncAmount) {
            const isTargetTjs = (p.currency || 'TJS').toUpperCase() === 'TJS';
            const targetAmount = isTargetTjs ? (newAmount * rate) : (newAmount / rate);
            updateObj.amount_minor = Math.round(targetAmount * 100);
            updateObj.comment = `Поступление от обмена ${newAmount} ${originalRecord.currency || 'USD'} по курсу ${rate}`;
          }

          if (Object.keys(updateObj).length > 0) {
            await db.from('payments').update(updateObj).eq('id', p.id);
          }
        }
      } else {
        // Find paired expense strictly by conversion_id or exact refSuffix
        let paired = [];
        if (originalRecord.conversion_id) {
          const { data } = await db.from('expenses').select('*').eq('conversion_id', originalRecord.conversion_id);
          paired = data || [];
        } else if (refSuffix) {
          const { data } = await db.from('expenses').select('*').in('reference', [`РКО-${refSuffix}`, `КОНВ-${refSuffix}`, `ОБМЕН-${refSuffix}`]);
          paired = data || [];
        }

        for (const e of paired) {
          const updateObj = {};
          if (newDate) updateObj.expense_date = targetDate;
          if (shouldSyncAmount) {
            const isSourceUsd = (e.currency || 'USD').toUpperCase() === 'USD';
            const sourceAmount = isSourceUsd ? (newAmount / rate) : (newAmount * rate);
            updateObj.amount_minor = Math.round(sourceAmount * 100);
            updateObj.description = `Обмен ${sourceAmount.toFixed(2)} ${e.currency || 'USD'} в ${originalRecord.currency || 'TJS'} по курсу ${rate}`;
          }

          if (Object.keys(updateObj).length > 0) {
            await db.from('expenses').update(updateObj).eq('id', e.id);
          }
        }
      }
    } catch (err) {
      console.warn('syncPairedConversion warning:', err.message);
    }
  }

  /**
   * Синхронное удаление парной операции конвертации
   */
  static async deletePairedConversion(type, record) {
    try {
      const db = getDB();
      if (!record) return;

      const isExp = type === 'EXPENSE';
      const ref = record.reference || '';
      const desc = (isExp ? record.description : record.comment) || '';
      const isConv = (record.category === 'Конвертация валюты') ||
                     (record.operation_type === 'CONVERSION') ||
                     Boolean(record.conversion_id) ||
                     ref.includes('КОНВ') || ref.includes('ОБМЕН') ||
                     desc.toLowerCase().includes('обмен') || desc.toLowerCase().includes('конвертаци');

      if (!isConv) return;

      const refSuffix = ref.replace(/^(ПКО-|ОБМЕН-|КОНВ-)/, '');

      if (isExp) {
        let paired = [];
        if (record.conversion_id) {
          const { data } = await db.from('payments').select('id').eq('conversion_id', record.conversion_id);
          paired = data || [];
        } else if (refSuffix) {
          const { data } = await db.from('payments').select('id').in('reference', [`ПКО-${refSuffix}`, `КОНВ-${refSuffix}`, `ОБМЕН-${refSuffix}`]);
          paired = data || [];
        }
        for (const p of paired) {
          await db.from('payments').delete().eq('id', p.id);
        }
      } else {
        let paired = [];
        if (record.conversion_id) {
          const { data } = await db.from('expenses').select('id').eq('conversion_id', record.conversion_id);
          paired = data || [];
        } else if (refSuffix) {
          const { data } = await db.from('expenses').select('id').in('reference', [`РКО-${refSuffix}`, `КОНВ-${refSuffix}`, `ОБМЕН-${refSuffix}`]);
          paired = data || [];
        }
        for (const e of paired) {
          await db.from('expenses').delete().eq('id', e.id);
        }
      }
    } catch (err) {
      console.warn('deletePairedConversion error:', err.message);
    }
  }

  /**
   * Ручная конвертация / валютообмен между кассами
   */
  static async convertCurrency(data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const fromCurrency = (data.from_currency || 'USD').toUpperCase();
    const toCurrency = (data.to_currency || 'TJS').toUpperCase();
    const parseNum = (val) => val !== undefined && val !== null && val !== '' ? Number(String(val).replace(',', '.').trim()) : null;
    const fromAmount = parseNum(data.from_amount) || 0;
    const rate = parseNum(data.exchange_rate) || 10.90;
    const toAmount = parseNum(data.to_amount) || (fromAmount * rate);
    const date = data.date || now.split('T')[0];

    const fromAmountMinor = Math.round(fromAmount * 100);
    const toAmountMinor = Math.round(toAmount * 100);

    const convId = `conv_${Date.now()}`;
    const expRef = data.reference || `ОБМЕН-${Date.now().toString().slice(-5)}`;
    const incRef = `ПКО-${expRef}`;

    // Resolve structured cash desk IDs
    const { data: dictDesks } = await db.from('dictionaries').select('*').eq('type', 'CASH_DESK').eq('is_active', true);
    const desks = dictDesks || [];

    const rawFrom = data.from_cash_desk_id || data.source_cash_desk_id;
    const rawTo = data.to_cash_desk_id || data.destination_cash_desk_id;

    if (!rawFrom || !rawTo) {
      const err = new Error('Для конвертации валют обязательны исходная и целевая кассы');
      err.statusCode = 400;
      err.code = 'CONVERSION_CASH_DESKS_REQUIRED';
      throw err;
    }

    let fromCashDeskId = await resolveCashDeskUuid(db, rawFrom);
    let toCashDeskId = await resolveCashDeskUuid(db, rawTo);

    if (!fromCashDeskId || !toCashDeskId) {
      const err = new Error('Указанная касса для конвертации валют не найдена или неактивна');
      err.statusCode = 400;
      err.code = 'CONVERSION_CASH_DESKS_REQUIRED';
      throw err;
    }

    const fromDeskObj = desks.find(d => d.id === fromCashDeskId);
    const toDeskObj = desks.find(d => d.id === toCashDeskId);

    // 1. Списание с кассы-источника (USD)
    const { data: exp, error: expErr } = await db.from('expenses').insert([{
      amount_minor: fromAmountMinor,
      currency: fromCurrency,
      expense_date: date,
      category: 'Конвертация валюты',
      method: data.method || 'CASH',
      reference: expRef,
      recipient: toDeskObj ? toDeskObj.name : `Касса ${toCurrency}`,
      description: `Обмен ${fromAmount.toLocaleString()} ${fromCurrency} в ${toCurrency} по курсу ${rate}. Назначение: ${data.comment || 'Пополнение кассы'}`,
      cash_desk_id: fromCashDeskId,
      conversion_id: convId,
      created_by_user_id: userId || null,
      created_at: now
    }]).select().single();
    if (expErr) throw expErr;

    // 2. Приход в кассу-получатель (TJS)
    const { data: inc, error: incErr } = await db.from('payments').insert([{
      amount_minor: toAmountMinor,
      currency: toCurrency,
      payment_date: date,
      method: data.method || 'CASH',
      reference: incRef,
      payer_name: fromDeskObj ? fromDeskObj.name : `Касса ${fromCurrency}`,
      comment: `Поступление от обмена ${fromAmount.toLocaleString()} ${fromCurrency} по курсу ${rate}`,
      cash_desk_id: toCashDeskId,
      conversion_id: convId,
      created_by_user_id: userId || null,
      created_at: now
    }]).select().single();
    if (incErr) throw incErr;

    return { expense: exp, income: inc };
  }

  /**
   * Получить ДДС (Движение Денежных Средств)
   */
  static async getCashflow(filters = {}, userAccess = null) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error: pErr } = await db.from('payments').select(`
      id, deal_id, amount_minor, currency, payment_date, method, settlement_method, reference, comment, payer_name, created_at,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate,
      conversion_id,
      deals ( id, contract_number, currency, deal_date, created_at, leads ( full_name, inn ) ),
      users:created_by_user_id ( name )
    `);
    if (pErr) throw pErr;

    const { data: expensesData, error: eErr } = await db.from('expenses').select(`
      id, amount_minor, currency, expense_date, category, method, settlement_method, reference, recipient, description, created_at,
      exchange_rate, amount_usd, conversion_expense_id,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type, amount_tjs,
      conversion_id,
      users:created_by_user_id ( name )
    `);
    if (eErr) throw eErr;

    // Filter out VOIDED items for financial calculations
    let activePayments = (paymentsData || []).filter(p => p.status !== 'VOIDED');
    let activeExpenses = (expensesData || []).filter(e => e.status !== 'VOIDED');

    // Серверная изоляция для менеджера: видит ТОЛЬКО свою кассу
    if (userAccess && !userAccess.isAdmin) {
      activePayments = activePayments.filter(p => p.cash_desk_id === userAccess.cashDeskId);
      activeExpenses = activeExpenses.filter(e => e.cash_desk_id === userAccess.cashDeskId);
    }


    // Collect all currencies
    const currencySet = new Set(['USD', 'TJS']);
    activePayments.forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      currencySet.add(c);
    });
    activeExpenses.forEach(e => {
      const c = (e.currency || 'USD').toUpperCase();
      currencySet.add(c);
    });
    const availableCurrencies = Array.from(currencySet);

    // Summary per currency
    const summaryByCurrency = {};
    availableCurrencies.forEach(c => {
      summaryByCurrency[c] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
    });

    activePayments.forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const d = new Date(p.payment_date);
      if (d.getFullYear() === currentYear) {
        const amt = (p.amount_minor || 0) / 100;
        if (!summaryByCurrency[c]) summaryByCurrency[c] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
        summaryByCurrency[c].totalIncome += amt;
      }
    });

    activeExpenses.forEach(e => {
      const c = (e.currency || 'USD').toUpperCase();
      const d = new Date(e.expense_date);
      if (d.getFullYear() === currentYear) {
        const amt = (e.amount_minor || 0) / 100;
        if (!summaryByCurrency[c]) summaryByCurrency[c] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
        summaryByCurrency[c].totalExpense += amt;
      }
    });

    Object.keys(summaryByCurrency).forEach(c => {
      const s = summaryByCurrency[c];
      s.totalIncome = Number(s.totalIncome.toFixed(2));
      s.totalExpense = Number(s.totalExpense.toFixed(2));
      s.netCashflow = Number((s.totalIncome - s.totalExpense).toFixed(2));
    });

    // Conversions statistics for the year
    let totalConvertedFromUsd = 0;
    let totalConvertedToTjs = 0;
    let conversionOperationsCount = 0;

    activeExpenses.forEach(e => {
      const isConv = e.category === 'Конвертация валюты' || (e.reference && e.reference.startsWith('КОНВ-')) || (e.reference && e.reference.startsWith('ОБМЕН-'));
      const d = new Date(e.expense_date);
      if (isConv && d.getFullYear() === currentYear) {
        const cur = (e.currency || 'USD').toUpperCase();
        const amt = (e.amount_minor || 0) / 100;
        if (cur === 'USD') {
          totalConvertedFromUsd += amt;
          conversionOperationsCount++;
        }
      }
    });

    activePayments.forEach(p => {
      const isConv = (p.reference && p.reference.includes('КОНВ')) || (p.reference && p.reference.includes('ОБМЕН')) || (p.comment && p.comment.includes('конвертаци'));
      const d = new Date(p.payment_date);
      if (isConv && d.getFullYear() === currentYear) {
        const cur = (p.currency || 'TJS').toUpperCase();
        const amt = (p.amount_minor || 0) / 100;
        if (cur === 'TJS') {
          totalConvertedToTjs += amt;
        }
      }
    });

    // FX Gain / Loss (Курсовая разница)
    // 1. Поступления в сомони (TJS inflow)
    let totalTjsInflow = 0;
    let totalTjsInflowUsdEquiv = 0;

    activePayments.forEach(p => {
      const d = new Date(p.payment_date);
      if (d.getFullYear() === currentYear) {
        const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
        const amt = (p.amount_minor || 0) / 100;
        let rate = 10.80;
        if (p.comment && p.comment.includes('Курс:')) {
          const match = p.comment.match(/Курс:\s*([\d\.]+)/);
          if (match && match[1]) rate = parseFloat(match[1]);
        }
        
        if (cur === 'TJS') {
          totalTjsInflow += amt;
          totalTjsInflowUsdEquiv += (amt / rate);
        } else if (p.comment && p.comment.includes('Внесено в кассу:') && p.comment.includes('TJS')) {
          const tjsMatch = p.comment.match(/Внесено в кассу:\s*([\d\s\.,]+)\s*TJS/);
          if (tjsMatch && tjsMatch[1]) {
            const rawTjs = parseFloat(tjsMatch[1].replace(/\s/g, '').replace(',', '.'));
            if (rawTjs > 0) {
              totalTjsInflow += rawTjs;
              totalTjsInflowUsdEquiv += amt; // amt is credited USD
            }
          }
        }
      }
    });

    const avgIncomeRate = totalTjsInflowUsdEquiv > 0 ? (totalTjsInflow / totalTjsInflowUsdEquiv) : 10.80;

    // 2. Расходы / конвертации в сомони (TJS outflow)
    let totalTjsOutflow = 0;
    let totalTjsOutflowUsdEquiv = 0;

    activeExpenses.forEach(e => {
      const d = new Date(e.expense_date);
      if (d.getFullYear() === currentYear) {
        const cur = (e.currency || 'USD').toUpperCase();
        const amt = (e.amount_minor || 0) / 100;
        let rate = 10.90;
        if (e.description && e.description.includes('курсу')) {
          const match = e.description.match(/курсу\s*([\d\.]+)/);
          if (match && match[1]) rate = parseFloat(match[1]);
        }

        if (cur === 'TJS') {
          totalTjsOutflow += amt;
          totalTjsOutflowUsdEquiv += (amt / rate);
        } else if (cur === 'USD' && (e.category === 'Конвертация валюты' || e.recipient?.includes('TJS'))) {
          totalTjsOutflowUsdEquiv += amt;
          totalTjsOutflow += (amt * rate);
        }
      }
    });

    const avgExpenseRate = totalTjsOutflowUsdEquiv > 0 ? (totalTjsOutflow / totalTjsOutflowUsdEquiv) : 10.90;

    // Курсовая разница в USD:
    // Сколько бы стоил этот расход по среднему курсу поступлений vs сколько фактически списано в USD
    let fxGainLossUsd = 0;
    if (totalTjsOutflow > 0 && avgIncomeRate > 0) {
      const costAtIncomeRate = totalTjsOutflow / avgIncomeRate;
      const actualCostUsd = totalTjsOutflowUsdEquiv;
      fxGainLossUsd = costAtIncomeRate - actualCostUsd;
    }
    const fxGainLossTjs = fxGainLossUsd * avgExpenseRate;

    // 3. Sales & Contracts KPI (Реализованные м², скидки, ожидаемый остаток рассрочки)
    const { data: allDealsData } = await db.from('deals').select(`
      id, status, base_price_minor, discount_minor, final_price_minor, down_payment_minor, currency,
      units ( area_m2_x100, rooms ),
      deal_payment_schedules ( amount_minor, paid_amount_minor, status )
    `);

    let totalSoldAreaM2 = 0;
    let totalDealsCount = 0;
    let totalContractSumUsd = 0;
    let totalDiscountSumUsd = 0;

    (allDealsData || []).forEach(d => {
      if (d.status !== 'CANCELLED') {
        const area = (d.units?.area_m2_x100 || 0) / 100;
        totalSoldAreaM2 += area;

        const discountAmt = (d.discount_minor || 0) / 100;
        totalDiscountSumUsd += discountAmt;

        if (d.status === 'SIGNED' || d.status === 'COMPLETED') {
          totalDealsCount++;
          const contractAmt = (d.final_price_minor || 0) / 100;
          totalContractSumUsd += contractAmt;
        }
      }
    });

    const totalPaymentsCollectedUsd = activePayments
      .filter(p => p.deal_id || p.dealId)
      .reduce((acc, p) => acc + ((p.amount_minor || 0) / 100), 0);
    const { data: schedData } = await db.from('deal_payment_schedules').select('paid_amount_minor');
    const totalSchedPaidUsd = (schedData || []).reduce((acc, s) => acc + ((s.paid_amount_minor || 0) / 100), 0);
    const totalReceivedSumUsd = Math.max(totalPaymentsCollectedUsd, totalSchedPaidUsd);

    const totalReceivableSumUsd = Math.max(0, totalContractSumUsd - totalReceivedSumUsd);

    const salesSummary = {
      totalSoldAreaM2: Number(totalSoldAreaM2.toFixed(1)),
      totalDealsCount,
      totalContractSumUsd: Number(totalContractSumUsd.toFixed(2)),
      totalDiscountSumUsd: Number(totalDiscountSumUsd.toFixed(2)),
      totalReceivedSumUsd: Number(totalReceivedSumUsd.toFixed(2)),
      totalReceivableSumUsd: Number(totalReceivableSumUsd.toFixed(2)),
    };

    // Monthly Data
    const eskhataRate = 9.27;
    const chartCurrency = selectedCurrency || 'USD';
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    const monthlyData = monthNames.map(month => ({ month, income: 0, expense: 0, net: 0 }));

    activePayments.forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const d = new Date(p.payment_date);
      if (d.getFullYear() === currentYear) {
        if (selectedCurrency && c !== selectedCurrency) return;
        const isInternal = (p.reference && p.reference.includes('КОНВ')) || (p.payer_name && p.payer_name.includes('Касса') && p.payer_name.includes('Автоконвертация'));
        if (!selectedCurrency && isInternal) return;

        let amt = (p.amount_minor || 0) / 100;
        if (!selectedCurrency) {
          amt = c === 'USD' ? amt : (amt / eskhataRate);
        }
        monthlyData[d.getMonth()].income += amt;
      }
    });

    activeExpenses.forEach(e => {
      const c = (e.currency || 'USD').toUpperCase();
      const d = new Date(e.expense_date);
      if (d.getFullYear() === currentYear) {
        if (selectedCurrency && c !== selectedCurrency) return;
        const isInternal = e.category === 'Конвертация валюты' || (e.recipient && e.recipient.includes('Касса') && e.recipient.includes('Автоконвертация')) || (e.reference && e.reference.startsWith('КОНВ-'));
        if (!selectedCurrency && isInternal) return;

        let amt = (e.amount_minor || 0) / 100;
        if (!selectedCurrency) {
          amt = c === 'USD' ? amt : (amt / eskhataRate);
        }
        monthlyData[d.getMonth()].expense += amt;
      }
    });

    monthlyData.forEach(m => {
      m.income = Number(m.income.toFixed(2));
      m.expense = Number(m.expense.toFixed(2));
      m.net = Number((m.income - m.expense).toFixed(2));
    });

    // Сводные остатки по каждой конкретной кассе компании строго на основе справочника
    const { data: dictDesks } = await db.from('dictionaries').select('*').eq('type', 'CASH_DESK').eq('is_active', true).order('sort_order');
    let activeDesks = dictDesks && dictDesks.length > 0 ? dictDesks : [
      { code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' },
      { code: 'SALES_MANAGER', name: 'Касса Отдела продаж (Акмалхон)' },
      { code: 'SALES_MANAGER_Dadojon', name: 'Касса менеждера (Дадочон)' },
      { code: 'BANK_ACCOUNT', name: 'Расчетный счет в банке (Безналичные)' }
    ];

    const mainCashier = activeDesks.find(d => d.code === 'MAIN_CASHIER') || activeDesks[0];

    const resolveDeskName = (cashDeskId, rawComment, rawRecipient) => {
      if (cashDeskId) {
        const strId = String(cashDeskId).toLowerCase();
        const directDesk = activeDesks.find(d => (d.id && String(d.id).toLowerCase() === strId) || (d.code && String(d.code).toLowerCase() === strId));
        if (directDesk) return directDesk.name;
      }
      const text = `${rawComment || ''} ${rawRecipient || ''}`;
      const match = text.match(/\[Касса:\s*([^\]]+)\]/i);
      let parsed = match ? match[1].trim() : '';
      if (!parsed && rawRecipient && rawRecipient.startsWith('Касса ')) {
        parsed = rawRecipient.trim();
      }
      if (parsed) {
        const directMatch = activeDesks.find(d => d.name.toLowerCase() === parsed.toLowerCase());
        if (directMatch) return directMatch.name;
        const prefixMatch = activeDesks.find(d => parsed.toLowerCase().startsWith(d.name.toLowerCase()) || d.name.toLowerCase().startsWith(parsed.toLowerCase()));
        if (prefixMatch) return prefixMatch.name;
      }
      return mainCashier.name;
    };

    // Pre-map conversion and transfer counterparts
    const convDeskMap = new Map();
    (expensesData || []).forEach(e => {
      if (e.conversion_id) {
        const deskName = resolveDeskName(e.cash_desk_id, e.description, e.recipient);
        convDeskMap.set(`exp_${e.conversion_id}`, { deskName, deskId: e.cash_desk_id });
      }
    });
    (paymentsData || []).forEach(p => {
      if (p.conversion_id) {
        const deskName = resolveDeskName(p.cash_desk_id, p.comment, p.payer_name);
        convDeskMap.set(`pay_${p.conversion_id}`, { deskName, deskId: p.cash_desk_id });
      }
    });

    const transferDeskMap = new Map();
    (expensesData || []).forEach(e => {
      if (e.transfer_id) {
        const deskName = resolveDeskName(e.cash_desk_id, e.description, e.recipient);
        transferDeskMap.set(`exp_${e.transfer_id}`, { deskName, deskId: e.cash_desk_id });
      }
    });
    (paymentsData || []).forEach(p => {
      if (p.transfer_id) {
        const deskName = resolveDeskName(p.cash_desk_id, p.comment, p.payer_name);
        transferDeskMap.set(`pay_${p.transfer_id}`, { deskName, deskId: p.cash_desk_id });
      }
    });

    // Unified Cashflow Ledger (transactions)
    const transactions = [];

    const txPayments = (paymentsData || []).filter(p => filters.include_voided ? true : p.status !== 'VOIDED');
    const txExpenses = (expensesData || []).filter(e => filters.include_voided ? true : e.status !== 'VOIDED');

    txPayments.forEach(p => {
      const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const amt = (p.amount_minor || 0) / 100;
      const isInternalTransfer = (p.operation_type === 'INTERNAL_CASH_TRANSFER' || p.operation_type === 'PAYMENT_ON_BEHALF' || p.transfer_id) ||
                                 (p.reference && p.reference.includes('ПЕРЕМ')) ||
                                 (p.comment && (p.comment.includes('Внутреннее перемещение') || p.comment.includes('Внутренее перемещение')));
      const isConv = (p.reference && p.reference.includes('КОНВ')) || (p.reference && p.reference.includes('ОБМЕН')) || (p.comment && p.comment.includes('конвертаци'));
      const dealDate = p.deals?.deal_date || (p.deals?.created_at ? p.deals.created_at.split('T')[0] : null);
      const dealObj = p.deals ? {
        id: p.deals.id,
        contract_number: p.deals.contract_number,
        deal_date: dealDate,
        currency: p.deals.currency,
        lead_name: p.deals.leads?.full_name,
        inn: p.deals.leads?.inn
      } : null;

      const isInvestment = p.operation_type === 'INVESTMENT' || p.category === 'Инвестиции партнёров';
      let category = 'Поступления по сделкам';
      let section = 'Операционная деятельность';
      let title = p.deals?.contract_number ? `Оплата по договору ${p.deals.contract_number}` : 'Приходный кассовый ордер';
      if (isInvestment) {
        category = p.category || 'Инвестиции партнёров';
        section = 'Финансовая деятельность';
        title = p.purpose || 'Инвестиция партнёра';
      } else if (isInternalTransfer) {
        category = 'Внутренние перемещения между кассами';
        title = 'Внутреннее перемещение между кассами';
      } else if (isConv) {
        category = 'Конвертация валюты';
        title = 'Поступление от конвертации';
      }

      const deskName = resolveDeskName(p.cash_desk_id, p.comment, p.payer_name);
      let counterpartDeskName = null;
      if (p.conversion_id && convDeskMap.has(`exp_${p.conversion_id}`)) {
        counterpartDeskName = convDeskMap.get(`exp_${p.conversion_id}`).deskName;
      } else if (p.transfer_id && transferDeskMap.has(`exp_${p.transfer_id}`)) {
        counterpartDeskName = transferDeskMap.get(`exp_${p.transfer_id}`).deskName;
      }
      const isBank = p.method === 'BANK_TRANSFER' || p.cash_desk_id === 'BANK_ACCOUNT' || deskName.includes('Расчетный счет');

      let cleanComment = (p.comment || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim();
      if (cleanComment.toLowerCase().includes('поступление от обмена') && p.amount_usd) {
        const usdVal = Number(p.amount_usd).toFixed(2);
        cleanComment = cleanComment.replace(/Поступление от обмена\s+\$?[\d\.]+\s*USD/i, `Поступление от обмена $${usdVal} USD`);
      }

      transactions.push({
        id: `inc-${p.id}`,
        rawId: p.id,
        dealId: p.deal_id,
        deal_id: p.deal_id,
        deal: dealObj,
        dealDate,
        contract: isInvestment ? 'Инвестиция партнёра' : (p.deals?.contract_number || null),
        contract_number: p.deals?.contract_number || null,
        type: 'INCOME',
        date: p.payment_date,
        amount: amt,
        amount_minor: p.amount_minor,
        currency: cur,
        category,
        section,
        title,
        counterparty: p.payer_name || p.deals?.leads?.full_name || (isInvestment ? 'Инвестор' : 'Клиент'),
        payer_name: p.payer_name || p.deals?.leads?.full_name || (isInvestment ? 'Инвестор' : 'Клиент'),
        method: p.method || 'CASH',
        reference: p.reference || `ПКО-${p.id}`,
        comment: (p.comment || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim(),
        status: p.status || 'ACTIVE',
        voidReason: p.void_reason || null,
        voidedAt: p.voided_at || null,
        transferId: p.transfer_id || null,
        transfer_id: p.transfer_id || null,
        conversion_id: p.conversion_id || null,
        cashDeskId: p.cash_desk_id || null,
        cash_desk_id: p.cash_desk_id || null,
        cashDeskName: p.cash_desk_id ? deskName : 'Без кассы',
        cash_desk_name: p.cash_desk_id ? deskName : 'Без кассы',
        counterpart_cash_desk_name: counterpartDeskName,
        account_id: isBank ? (p.cash_desk_id || 'BANK_ACCOUNT') : null,
        account_name: isBank ? deskName : null,
        operationType: p.operation_type || 'STANDARD',
        operation_type: p.operation_type || 'STANDARD',
        projectId: p.project_id || null,
        project_id: p.project_id || null,
        basis: p.basis || null,
        purpose: p.purpose || null,
        amount_usd: p.amount_usd ? Number(p.amount_usd) : null,
        amount_tjs: p.amount_tjs ? Number(p.amount_tjs) : null,
        exchange_rate: p.exchange_rate ? Number(p.exchange_rate) : null,
        createdByName: p.users?.name || 'Система',
        createdAt: p.created_at
      });
    });

    txExpenses.forEach(e => {
      const cur = (e.currency || 'USD').toUpperCase();
      const amt = (e.amount_minor || 0) / 100;
      const isInternalTransfer = (e.operation_type === 'INTERNAL_CASH_TRANSFER' || e.operation_type === 'PAYMENT_ON_BEHALF' || e.transfer_id) ||
                                 (e.reference && e.reference.includes('ПЕРЕМ')) ||
                                 (e.category === 'Внутренние перемещения между кассами') ||
                                 (e.description && (e.description.includes('Внутреннее перемещение') || e.description.includes('Внутренее перемещение')));
      const isConv = e.category === 'Конвертация валюты' || (e.reference && e.reference.startsWith('КОНВ-')) || (e.reference && e.reference.startsWith('ОБМЕН-'));
      
      let title = isInternalTransfer
        ? 'Внутреннее перемещение между кассами'
        : isConv
        ? 'Списание на конвертацию'
        : `Расход: ${e.category || 'Прочее'}`;

      const deskName = resolveDeskName(e.cash_desk_id, e.description, e.recipient);
      let counterpartDeskName = null;
      if (e.conversion_id && convDeskMap.has(`pay_${e.conversion_id}`)) {
        counterpartDeskName = convDeskMap.get(`pay_${e.conversion_id}`).deskName;
      } else if (e.transfer_id && transferDeskMap.has(`pay_${e.transfer_id}`)) {
        counterpartDeskName = transferDeskMap.get(`pay_${e.transfer_id}`).deskName;
      }
      const isBank = e.method === 'BANK_TRANSFER' || e.cash_desk_id === 'BANK_ACCOUNT' || deskName.includes('Расчетный счет');

      let cleanDesc = (e.description || '').replace(/\[IDEMP:[^\]]+\]\s*/gi, '').trim();
      if ((isConv || e.operation_type === 'CONVERSION' || e.reference?.startsWith('КОНВ-')) && cleanDesc.toLowerCase().startsWith('обмен')) {
        const rateMatch = cleanDesc.match(/курсу\s*([\d\.,]+)/i);
        const rate = rateMatch ? rateMatch[1] : (e.exchange_rate || '9.27');
        cleanDesc = `Обмен ${amt.toFixed(2)} ${cur} в TJS по курсу ${rate}`;
      }

      transactions.push({
        id: `exp-${e.id}`,
        rawId: e.id,
        type: 'EXPENSE',
        date: e.expense_date,
        amount: amt,
        amount_minor: e.amount_minor,
        currency: cur,
        category: e.category || 'Прочее',
        title,
        counterparty: e.recipient || 'Контрагент',
        recipient: e.recipient || 'Контрагент',
        method: e.method || 'CASH',
        reference: e.reference || `РКО-${e.id}`,
        comment: cleanDesc,
        description: cleanDesc,
        status: e.status || 'ACTIVE',
        voidReason: e.void_reason || null,
        voidedAt: e.voided_at || null,
        transferId: e.transfer_id || null,
        transfer_id: e.transfer_id || null,
        conversion_id: e.conversion_id || null,
        cashDeskId: e.cash_desk_id || null,
        cash_desk_id: e.cash_desk_id || null,
        cashDeskName: e.cash_desk_id ? deskName : 'Без кассы',
        cash_desk_name: e.cash_desk_id ? deskName : 'Без кассы',
        counterpart_cash_desk_name: counterpartDeskName,
        account_id: isBank ? (e.cash_desk_id || 'BANK_ACCOUNT') : null,
        account_name: isBank ? deskName : null,
        operationType: e.operation_type || 'STANDARD',
        operation_type: e.operation_type || 'STANDARD',
        exchange_rate: e.exchange_rate ? Number(e.exchange_rate) : null,
        amount_usd: e.amount_usd ? Number(e.amount_usd) : null,
        amount_tjs: e.amount_tjs ? Number(e.amount_tjs) : null,
        conversion_expense_id: e.conversion_expense_id || null,
        createdByName: e.users?.name || 'Администратор',
        createdAt: e.created_at
      });
    });

    // Сортировка по связанным парам/семействам операций (конвертации, перемещения), чтобы связанные документы всегда стояли строго рядом
    const convExpToConvId = new Map();
    transactions.forEach(t => {
      if (t.conversion_id && t.rawId) {
        convExpToConvId.set(t.rawId, t.conversion_id);
      }
    });

    const getGroupKey = (t) => {
      if (t.transfer_id) return 'transfer:' + t.transfer_id;
      if (t.conversion_id) return 'conversion:' + t.conversion_id;
      if (t.conversion_expense_id && convExpToConvId.has(t.conversion_expense_id)) {
        return 'conversion:' + convExpToConvId.get(t.conversion_expense_id);
      }
      const m = (t.reference || '').match(/(?:КОНВ|ПКО-КОНВ|ОБМЕН|ПЕРЕМ)-(\d+)/i);
      if (m) {
        const num = m[1];
        if (t.reference.includes('ПЕРЕМ')) return 'transfer_num:' + num;
        return 'conv_num:' + num;
      }
      return 'single:' + t.id;
    };

    const groups = new Map();
    transactions.forEach(t => {
      const key = getGroupKey(t);
      if (!groups.has(key)) {
        groups.set(key, { key, items: [], maxDate: t.date, maxCreatedAt: t.createdAt });
      }
      const g = groups.get(key);
      g.items.push(t);
      if (new Date(t.date) > new Date(g.maxDate)) g.maxDate = t.date;
      if (new Date(t.createdAt) > new Date(g.maxCreatedAt)) g.maxCreatedAt = t.createdAt;
    });

    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
      const dDiff = new Date(b.maxDate) - new Date(a.maxDate);
      if (dDiff !== 0) return dDiff;
      return new Date(b.maxCreatedAt) - new Date(a.maxCreatedAt);
    });

    const itemOrder = (item) => {
      const isConvExp = item.type === 'EXPENSE' && (item.category === 'Конвертация валюты' || item.reference?.startsWith('КОНВ-') || item.reference?.startsWith('ОБМЕН-'));
      if (isConvExp) return 1;
      const isConvInc = item.type === 'INCOME' && (item.category === 'Конвертация валюты' || item.reference?.startsWith('ПКО-КОНВ-') || item.reference?.startsWith('ПКО-ОБМЕН-'));
      if (isConvInc) return 2;
      const isTransExp = item.type === 'EXPENSE' && (item.operationType === 'INTERNAL_CASH_TRANSFER' || item.reference?.includes('ПЕРЕМ'));
      if (isTransExp) return 1;
      const isTransInc = item.type === 'INCOME' && (item.operationType === 'INTERNAL_CASH_TRANSFER' || item.reference?.includes('ПЕРЕМ'));
      if (isTransInc) return 2;
      return 3;
    };

    const sortedTransactions = [];
    sortedGroups.forEach(g => {
      g.items.sort((a, b) => itemOrder(a) - itemOrder(b));
      sortedTransactions.push(...g.items);
    });

    transactions.length = 0;
    transactions.push(...sortedTransactions);

    let filteredTransactions = transactions;
    if (selectedCurrency) {
      filteredTransactions = filteredTransactions.filter(t => t.currency === selectedCurrency);
    }
    if (filters.cash_desk_id && filters.cash_desk_id !== 'ALL') {
      filteredTransactions = filteredTransactions.filter(t => t.cashDeskId === filters.cash_desk_id || t.cash_desk_id === filters.cash_desk_id);
    }
    if (filters.project_id && filters.project_id !== 'ALL') {
      filteredTransactions = filteredTransactions.filter(t => Number(t.projectId) === Number(filters.project_id) || Number(t.project_id) === Number(filters.project_id));
    }
    if (filters.partner && String(filters.partner).trim()) {
      const q = String(filters.partner).toLowerCase();
      filteredTransactions = filteredTransactions.filter(t => (t.counterparty && t.counterparty.toLowerCase().includes(q)) || (t.payer_name && t.payer_name.toLowerCase().includes(q)));
    }
    if (filters.category && filters.category !== 'ALL') {
      filteredTransactions = filteredTransactions.filter(t => t.category === filters.category);
    }
    if (filters.date_from) {
      filteredTransactions = filteredTransactions.filter(t => t.date >= filters.date_from);
    }
    if (filters.date_to) {
      filteredTransactions = filteredTransactions.filter(t => t.date <= filters.date_to);
    }
    if (filters.type && filters.type !== 'ALL') {
      filteredTransactions = filteredTransactions.filter(t => t.type === filters.type);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filteredTransactions = filteredTransactions.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.counterparty && t.counterparty.toLowerCase().includes(q)) ||
        (t.category && t.category.toLowerCase().includes(q)) ||
        (t.reference && t.reference.toLowerCase().includes(q)) ||
        (t.comment && t.comment.toLowerCase().includes(q))
      );
    }

    // Изоляция касс для менеджера
    if (userAccess && !userAccess.isAdmin) {
      activeDesks = activeDesks.filter(d => d.id === userAccess.cashDeskId || d.code === userAccess.cashDeskId);
      filteredTransactions = filteredTransactions.filter(t => t.cashDeskId === userAccess.cashDeskId);
    }

    // Динамический расчёт остатков касс (Strictly Dynamic SUM(PKO) - SUM(RKO))
    const cashDesksMap = {};
    activeDesks.forEach(d => {
      cashDesksMap[d.name] = { 
        name: d.name, 
        icon: d.icon || '🏢',
        USD: 0,
        TJS: 0,
        RUB: 0, 
        totalIncomeUsd: 0, totalIncomeTjs: 0, 
        totalExpenseUsd: 0, totalExpenseTjs: 0 
      };
    });

    const PROVEN_BARTER_PKO_IDS = [94, 96, 98];
    const PROVEN_BARTER_RKO_IDS = [165, 167, 169];

    activePayments.forEach(p => {
      const sm = p.settlement_method || (PROVEN_BARTER_PKO_IDS.includes(p.id) ? 'NON_CASH_BARTER' : 'CASH');
      if (sm === 'NON_CASH_BARTER' || sm === 'BANK') return;

      const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const amt = (p.amount_minor || 0) / 100;
      const deskName = resolveDeskName(p.cash_desk_id, p.comment, p.payer_name);

      if (!cashDesksMap[deskName]) {
        cashDesksMap[deskName] = { name: deskName, USD: 0, TJS: 0, RUB: 0, totalIncomeUsd: 0, totalIncomeTjs: 0, totalExpenseUsd: 0, totalExpenseTjs: 0 };
      }
      if (cur === 'USD') {
        cashDesksMap[deskName].USD += amt;
        cashDesksMap[deskName].totalIncomeUsd += amt;
      } else if (cur === 'TJS') {
        cashDesksMap[deskName].TJS += amt;
        cashDesksMap[deskName].totalIncomeTjs += amt;
      } else if (cur === 'RUB') {
        cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) + amt;
      }
    });

    activeExpenses.forEach(e => {
      const sm = e.settlement_method || (PROVEN_BARTER_RKO_IDS.includes(e.id) ? 'NON_CASH_BARTER' : 'CASH');
      if (sm === 'NON_CASH_BARTER' || sm === 'BANK') return;

      const cur = (e.currency || 'USD').toUpperCase();
      const amt = (e.amount_minor || 0) / 100;
      const deskName = resolveDeskName(e.cash_desk_id, e.description, e.recipient);

      if (!cashDesksMap[deskName]) {
        cashDesksMap[deskName] = { name: deskName, USD: 0, TJS: 0, RUB: 0, totalIncomeUsd: 0, totalIncomeTjs: 0, totalExpenseUsd: 0, totalExpenseTjs: 0 };
      }
      if (cur === 'USD') {
        cashDesksMap[deskName].USD -= amt;
        cashDesksMap[deskName].totalExpenseUsd += amt;
      } else if (cur === 'TJS') {
        cashDesksMap[deskName].TJS -= amt;
        cashDesksMap[deskName].totalExpenseTjs += amt;
      } else if (cur === 'RUB') {
        cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) - amt;
      }
    });

    const cashDesksSummary = Object.values(cashDesksMap).map(d => ({
      name: d.name,
      icon: d.icon,
      balanceUsd: Number(d.USD.toFixed(2)),
      balanceTjs: Number(d.TJS.toFixed(2)),
      balanceRub: Number((d.RUB || 0).toFixed(2)),
      totalIncomeUsd: Number(d.totalIncomeUsd.toFixed(2)),
      totalExpenseUsd: Number(d.totalExpenseUsd.toFixed(2)),
      totalIncomeTjs: Number(d.totalIncomeTjs.toFixed(2)),
      totalExpenseTjs: Number(d.totalExpenseTjs.toFixed(2)),
      hasBalance: true
    }));

    if (userAccess && !userAccess.isAdmin) {
      // Для менеджера: сводка отражает строго баланс его персональной кассы
      const managerDesk = Object.values(cashDesksMap)[0];
      if (summaryByCurrency['USD']) {
        summaryByCurrency['USD'] = {
          totalIncome: Number((managerDesk?.totalIncomeUsd || 0).toFixed(2)),
          totalExpense: Number((managerDesk?.totalExpenseUsd || 0).toFixed(2)),
          netCashflow: Number((managerDesk?.USD || 0).toFixed(2))
        };
      }
      if (summaryByCurrency['TJS']) {
        summaryByCurrency['TJS'] = {
          totalIncome: Number((managerDesk?.totalIncomeTjs || 0).toFixed(2)),
          totalExpense: Number((managerDesk?.totalExpenseTjs || 0).toFixed(2)),
          netCashflow: Number((managerDesk?.TJS || 0).toFixed(2))
        };
      }
    } else {
      const totalCapitalUsd = Number(Object.values(cashDesksMap).reduce((sum, d) => sum + (d.USD || 0), 0).toFixed(2));
      const totalCapitalTjs = Number(Object.values(cashDesksMap).reduce((sum, d) => sum + (d.TJS || 0), 0).toFixed(2));
      if (summaryByCurrency['USD']) {
        summaryByCurrency['USD'].netCashflow = totalCapitalUsd;
      }
      if (summaryByCurrency['TJS']) {
        summaryByCurrency['TJS'].netCashflow = totalCapitalTjs;
      }
    }

    return {
      summaryByCurrency,
      cashDesksSummary,
      availableCurrencies,
      availableYears,
      conversionsSummary: (userAccess && !userAccess.isAdmin) ? {
        totalConvertedFromUsd: 0,
        totalConvertedToTjs: 0,
        conversionOperationsCount: 0
      } : {
        totalConvertedFromUsd: Number(totalConvertedFromUsd.toFixed(2)),
        totalConvertedToTjs: Number(totalConvertedToTjs.toFixed(2)),
        conversionOperationsCount
      },
      fxSummary: (userAccess && !userAccess.isAdmin) ? {
        avgIncomeRate: 0,
        avgExpenseRate: 0,
        totalTjsInflow: 0,
        totalTjsOutflow: 0,
        fxGainLossUsd: 0,
        fxGainLossTjs: 0,
        isProfit: true
      } : {
        avgIncomeRate: Number(avgIncomeRate.toFixed(2)),
        avgExpenseRate: Number(avgExpenseRate.toFixed(2)),
        totalTjsInflow: Number(totalTjsInflow.toFixed(2)),
        totalTjsOutflow: Number(totalTjsOutflow.toFixed(2)),
        fxGainLossUsd: Number(fxGainLossUsd.toFixed(2)),
        fxGainLossTjs: Number(fxGainLossTjs.toFixed(2)),
        isProfit: fxGainLossUsd >= 0
      },
      salesSummary: (userAccess && !userAccess.isAdmin) ? {
        totalSoldAreaM2: 0,
        totalDealsCount: 0,
        totalContractSumUsd: 0,
        totalDiscountSumUsd: 0,
        totalReceivedSumUsd: 0,
        totalReceivableSumUsd: 0,
      } : salesSummary,
      monthlyData,
      chartCurrency,
      transactions: filteredTransactions
    };
  }

  /**
   * Атомарное создание внутреннего перемещения между кассами
   */
  static async createCashTransfer(data, userId) {
    const db = getDB();
    const {
      source_cash_desk_id,
      destination_cash_desk_id,
      operation_type = 'INTERNAL_CASH_TRANSFER',
      currency = 'USD',
      amount,
      amount_tjs,
      amount_usd,
      exchange_rate,
      date,
      recipient,
      description,
      idempotency_key
    } = data;

    const parseNum = (val) => {
      if (val === undefined || val === null || val === '') return null;
      const parsed = Number(String(val).replace(',', '.').trim());
      return isNaN(parsed) ? null : parsed;
    };

    let finalAmountTjs = null;
    let finalExchangeRate = null;
    let finalAmountUsd = null;

    if (currency === 'TJS') {
      finalAmountTjs = parseNum(amount_tjs || amount);
      finalExchangeRate = parseNum(exchange_rate);
      finalAmountUsd = parseNum(amount_usd) || (finalAmountTjs && finalExchangeRate ? Number((finalAmountTjs / finalExchangeRate).toFixed(2)) : null);
    } else {
      finalAmountUsd = parseNum(amount_usd || amount);
    }

    if (!source_cash_desk_id || !destination_cash_desk_id) {
      const err = new Error('Для внутреннего перемещения обязательны исходная и целевая кассы');
      err.statusCode = 400;
      err.code = 'TRANSFER_CASH_DESKS_REQUIRED';
      throw err;
    }

    const resolvedSourceId = await resolveCashDeskUuid(db, source_cash_desk_id);
    const resolvedDestId = await resolveCashDeskUuid(db, destination_cash_desk_id);

    if (!resolvedSourceId || !resolvedDestId) {
      const err = new Error('Указанная касса для внутреннего перемещения не найдена или неактивна');
      err.statusCode = 400;
      err.code = 'TRANSFER_CASH_DESKS_REQUIRED';
      throw err;
    }

    const { data: result, error } = await db.rpc('create_atomic_cash_transfer', {
      p_source_cash_desk_id: resolvedSourceId,
      p_destination_cash_desk_id: resolvedDestId,
      p_operation_type: operation_type,
      p_currency: currency,
      p_amount_tjs: finalAmountTjs,
      p_exchange_rate: finalExchangeRate,
      p_amount_usd: finalAmountUsd,
      p_transfer_date: date || new Date().toISOString().split('T')[0],
      p_recipient: recipient || 'Касса-получатель',
      p_description: description || 'Внутреннее перемещение между кассами',
      p_idempotency_key: idempotency_key || null,
      p_user_id: parseOptionalBigInt(userId) || 1
    });

    if (error) throw error;
    return result;
  }

  /**
   * План-Факт матрица платежей по каждому клиенту и месяцам года
   */
  static async getPlanFactReport(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const selectedProject = filters.project_id && filters.project_id !== 'ALL' ? filters.project_id : null;
    const selectedPaymentType = filters.payment_type && filters.payment_type !== 'ALL' ? filters.payment_type : null;
    const selectedLeadId = filters.lead_id && filters.lead_id !== 'ALL' ? filters.lead_id : null;
    const availableYears = await this.getAvailableYears();

    // Fetch deals with schedules, payments, leads, and units hierarchy
    const { data: dealsData, error: dErr } = await db.from('deals').select(`
      id, contract_number, status, payment_type, currency, final_price_minor, base_price_minor,
      discount_minor, down_payment_minor, installment_months, deal_date, created_at,
      leads ( id, full_name, phone ),
      units (
        id, unit_number,
        floors ( sections ( buildings ( projects ( id, name, currency ) ) ) )
      ),
      deal_payment_schedules (
        id, payment_number, due_date, amount_minor, paid_amount_minor, status
      ),
      payments (
        id, amount_minor, currency, payment_date, method, reference, comment
      )
    `).order('id', { ascending: true });

    if (dErr) throw dErr;

    let deals = dealsData || [];

    // Filter deals
    if (selectedCurrency) {
      deals = deals.filter(d => (d.currency || d.units?.floors?.sections?.buildings?.projects?.currency || 'USD') === selectedCurrency);
    }
    if (selectedProject) {
      deals = deals.filter(d => {
        const p = d.units?.floors?.sections?.buildings?.projects;
        return p && (String(p.id) === String(selectedProject) || p.name === selectedProject);
      });
    }
    if (selectedPaymentType) {
      deals = deals.filter(d => d.payment_type === selectedPaymentType);
    }
    if (selectedLeadId) {
      deals = deals.filter(d => String(d.leads?.id) === String(selectedLeadId));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      deals = deals.filter(d =>
        (d.contract_number && d.contract_number.toLowerCase().includes(q)) ||
        (d.leads?.full_name && d.leads?.full_name.toLowerCase().includes(q)) ||
        (d.units?.floors?.sections?.buildings?.projects?.name && d.units?.floors?.sections?.buildings?.projects?.name.toLowerCase().includes(q))
      );
    }

    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];

    const monthsHeader = monthNames.map((name, idx) => ({
      index: idx,
      name: `${name} ${currentYear}`,
      shortName: name,
      key: `${currentYear}-${String(idx + 1).padStart(2, '0')}`
    }));

    const monthTotals = Array(12).fill(0).map(() => ({ planned: 0, actual: 0 }));
    let grandTotalContract = 0;
    let grandTotalPaid = 0;
    let grandTotalDebt = 0;

    const rows = deals.map(d => {
      const proj = d.units?.floors?.sections?.buildings?.projects;
      const currency = d.currency || proj?.currency || 'USD';
      const contractAmount = (d.final_price_minor || 0) / 100;
      
      const schedules = d.deal_payment_schedules || [];
      const payments = d.payments || [];

      const paymentsTotal = payments.reduce((sum, p) => sum + ((p.amount_minor || 0) / 100), 0);
      const schedulesPaidTotal = schedules.reduce((sum, s) => sum + ((s.paid_amount_minor || 0) / 100), 0);
      const downPayment = (d.down_payment_minor || 0) / 100;
      const totalPaid = Math.max(paymentsTotal, schedulesPaidTotal, downPayment);
      const remainingDebt = Math.max(0, contractAmount - totalPaid);

      grandTotalContract += contractAmount;
      grandTotalPaid += totalPaid;
      grandTotalDebt += remainingDebt;

      const monthlyValues = Array(12).fill(0).map(() => ({ planned: 0, actual: 0 }));

      // Plan from schedules
      schedules.forEach(s => {
        if (s.due_date) {
          const sDate = new Date(s.due_date);
          if (sDate.getFullYear() === currentYear) {
            const m = sDate.getMonth();
            const planAmt = (s.amount_minor || 0) / 100;
            monthlyValues[m].planned += planAmt;
          }
        }
      });

      // Fact from payments
      payments.forEach(p => {
        if (p.payment_date) {
          const pDate = new Date(p.payment_date);
          if (pDate.getFullYear() === currentYear) {
            const m = pDate.getMonth();
            const factAmt = (p.amount_minor || 0) / 100;
            monthlyValues[m].actual += factAmt;
          }
        }
      });

      // If deal down payment was on deal_date and in this year, add to fact if not already in payments
      if (d.deal_date && downPayment > 0 && payments.length === 0) {
        const dDate = new Date(d.deal_date);
        if (dDate.getFullYear() === currentYear) {
          const m = dDate.getMonth();
          monthlyValues[m].actual += downPayment;
        }
      }

      monthlyValues.forEach((mv, mIdx) => {
        monthTotals[mIdx].planned += mv.planned;
        monthTotals[mIdx].actual += mv.actual;
      });

      return {
        id: d.id,
        contractNumber: d.contract_number ? `№ ${d.contract_number}` : `№ ${d.id}`,
        dealId: d.id,
        clientName: d.leads?.full_name || 'Не указан',
        clientPhone: d.leads?.phone || '',
        projectName: proj?.name || 'TOZON PLAZA',
        unitNumber: d.units?.unit_number || '-',
        paymentType: d.payment_type || 'INSTALLMENT',
        currency,
        contractAmount: Number(contractAmount.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        remainingDebt: Number(remainingDebt.toFixed(2)),
        months: monthlyValues.map(mv => ({
          planned: Number(mv.planned.toFixed(2)),
          actual: Number(mv.actual.toFixed(2))
        }))
      };
    });

    return {
      monthsHeader,
      rows,
      availableYears,
      summary: {
        totalDeals: rows.length,
        grandTotalContract: Number(grandTotalContract.toFixed(2)),
        grandTotalPaid: Number(grandTotalPaid.toFixed(2)),
        grandTotalDebt: Number(grandTotalDebt.toFixed(2)),
        monthTotals: monthTotals.map(mt => ({
          planned: Number(mt.planned.toFixed(2)),
          actual: Number(mt.actual.toFixed(2))
        }))
      }
    };
  }

  /**
   * Safe regression guard: Only allows voiding a legacy PKO/RKO pair as REENTERED_VIA_ATOMIC_CASH_TRANSFER
   * if a matching active cash_transfers row exists in the database.
   */
  static async supersedeLegacyTransferPair(expenseId, paymentId, voidReason = 'REENTERED_VIA_ATOMIC_CASH_TRANSFER', userId = 1) {
    const db = getDB();

    const { data: expense } = await db.from('expenses').select('*').eq('id', expenseId).maybeSingle();
    const { data: payment } = await db.from('payments').select('*').eq('id', paymentId).maybeSingle();

    if (!expense || !payment) {
      throw new Error(`LEGACY_TRANSFER_PAIR_NOT_FOUND: Expense #${expenseId} or Payment #${paymentId} does not exist`);
    }

    const { data: matchingTransfers } = await db.from('cash_transfers')
      .select('*')
      .eq('status', 'ACTIVE')
      .eq('amount_minor', expense.amount_minor)
      .eq('currency', expense.currency)
      .eq('source_cash_desk_id', expense.cash_desk_id)
      .eq('destination_cash_desk_id', payment.cash_desk_id);

    if (!matchingTransfers || matchingTransfers.length === 0) {
      throw new Error(
        `CANNOT_VOID_LEGACY_TRANSFER_WITHOUT_ATOMIC_RECORD: No active matching cash_transfers row found for Expense #${expenseId} ($${(expense.amount_minor/100).toFixed(2)}) and Payment #${paymentId} ($${(payment.amount_minor/100).toFixed(2)}).`
      );
    }

    await db.from('expenses').update({
      status: 'VOIDED',
      void_reason: voidReason,
      voided_at: new Date().toISOString(),
      voided_by: userId
    }).eq('id', expenseId);

    await db.from('payments').update({
      status: 'VOIDED',
      void_reason: voidReason,
      voided_at: new Date().toISOString(),
      voided_by: userId
    }).eq('id', paymentId);

    return { success: true, supersededExpenseId: expenseId, supersededPaymentId: paymentId };
  }
}

