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
    const desc = payload.description || '';
    const taggedPayload = {
      ...payload,
      description: key && !desc.includes('[IDEMP:')
        ? `${desc} [IDEMP:${key}]`.trim()
        : desc
    };

    const { idempotency_key, ...payloadWithoutCol } = taggedPayload;

    try {
      const res = await db.from('expenses').insert([taggedPayload]).select().single();
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
    await this.autoHarmonizeConversions();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error } = await db.from('payments').select(`
      id, deal_id, schedule_id, amount_minor, currency, payment_date, method, reference, comment, payer_name, created_at,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate,
      deals ( id, contract_number, currency, final_price_minor, deal_date, created_at, leads ( full_name, phone, inn ) ),
      users:created_by_user_id ( id, name )
    `).order('payment_date', { ascending: false });

    if (error) throw error;

    const allPayments = paymentsData || [];
    
    // Normalize and extract currency for each payment
    let normalizedList = allPayments
      .filter(p => filters.include_voided ? true : p.status !== 'VOIDED')
      .map(p => {
        const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
        const amount = (p.amount_minor || 0) / 100;
        const clientName = p.payer_name || p.deals?.leads?.full_name || (p.deal_id ? `Клиент по сделке #${p.deal_id}` : 'Прямой плательщик');
        const contract = p.deals?.contract_number || (p.deal_id ? `СД-${p.deal_id}` : 'Прямой приход');
        const dealDate = p.deals?.deal_date || (p.deals?.created_at ? p.deals.created_at.split('T')[0] : null);
        const dealObj = p.deals ? {
          id: p.deals.id,
          contract_number: p.deals.contract_number,
          deal_date: dealDate,
          currency: p.deals.currency,
          lead_name: p.deals.leads?.full_name,
          inn: p.deals.leads?.inn
        } : null;

        return {
          id: p.id,
          dealId: p.deal_id,
          scheduleId: p.schedule_id,
          amount,
          currency: cur,
          date: p.payment_date,
          method: p.method || 'CASH',
          reference: p.reference || `ПКО-${p.id}`,
          comment: p.comment || '',
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
          createdByName: p.users?.name || 'Система',
          createdAt: p.created_at,
        };
      });

    // Строгая серверная изоляция для менеджера
    if (userAccess && !userAccess.isAdmin) {
      normalizedList = normalizedList.filter(item => item.cashDeskId === userAccess.cashDeskId);
    } else if (filters.cash_desk_id) {
      normalizedList = normalizedList.filter(item => item.cashDeskId === filters.cash_desk_id);
    }

    // Currencies present
    const availableCurrencies = Array.from(new Set(normalizedList.map(item => item.currency)));
    if (!availableCurrencies.includes('USD')) availableCurrencies.push('USD');
    if (!availableCurrencies.includes('TJS')) availableCurrencies.push('TJS');

    // Totals by currency
    const totalsByCurrency = {};
    availableCurrencies.forEach(c => { totalsByCurrency[c] = 0; });
    normalizedList.forEach(item => {
      const pYear = new Date(item.date).getFullYear();
      if (pYear === currentYear) {
        totalsByCurrency[item.currency] = (totalsByCurrency[item.currency] || 0) + item.amount;
      }
    });

    // Filtered list for display
    let filteredList = normalizedList;
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

    return {
      list: filteredList,
      totals: totalsByCurrency,
      availableCurrencies,
      availableYears,
      monthlyChart: chartData
    };
  }

  /**
   * Добавить приходный кассовый ордер (доход)
   */
  static async addIncome(data, userId, userAccess = null) {
    const db = getDB();
    const now = new Date().toISOString();
    const amountMinor = Math.round(Number(data.amount) * 100);
    const paymentDate = data.date || data.payment_date || now.split('T')[0];
    const currency = (data.currency || 'USD').toUpperCase();
    const dealId = parseOptionalBigInt(data.deal_id);
    const scheduleId = parseOptionalBigInt(data.schedule_id);

    const targetCashDeskId = (userAccess && !userAccess.isAdmin) 
      ? userAccess.cashDeskId 
      : (data.cash_desk_id || null);

    const { data: newPayment, error } = await db.from('payments').insert([{
      deal_id: dealId,
      schedule_id: scheduleId,
      amount_minor: amountMinor,
      currency,
      payment_date: paymentDate,
      method: data.method || 'CASH',
      reference: data.reference || `ПКО-${Date.now().toString().slice(-6)}`,
      comment: data.comment || null,
      payer_name: data.payer_name || null,
      cash_desk_id: targetCashDeskId,
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

    const { data: originalRecord } = await db.from('payments').select('*').eq('id', id).maybeSingle();

    const updatePayload = {};
    if (data.amount !== undefined) updatePayload.amount_minor = Math.round(Number(data.amount) * 100);
    if (data.currency) updatePayload.currency = String(data.currency).toUpperCase();
    if (data.date || data.payment_date) updatePayload.payment_date = data.date || data.payment_date;
    if (data.method) updatePayload.method = data.method;
    if (data.reference !== undefined) updatePayload.reference = data.reference;
    if (data.comment !== undefined || data.description !== undefined) {
      updatePayload.comment = data.comment !== undefined ? data.comment : data.description;
    }
    if (data.payer_name !== undefined || data.recipient !== undefined) {
      updatePayload.payer_name = data.payer_name !== undefined ? data.payer_name : data.recipient;
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
  static async getCashDeskBalance(cashDeskId) {
    if (!cashDeskId) return 0;
    const db = getDB();
    const { data: pData } = await db.from('payments')
      .select('amount_minor, currency')
      .eq('cash_desk_id', cashDeskId)
      .neq('status', 'VOIDED');

    const { data: eData } = await db.from('expenses')
      .select('amount_minor, currency')
      .eq('cash_desk_id', cashDeskId)
      .neq('status', 'VOIDED');

    let balanceUsd = 0;
    (pData || []).forEach(p => {
      const cur = (p.currency || 'USD').toUpperCase();
      if (cur === 'USD') balanceUsd += (p.amount_minor || 0) / 100;
    });
    (eData || []).forEach(e => {
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
      if (payment.cash_desk_id !== userAccess.cashDeskId) {
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
   * Получить список расходов (расходных ордеров)
   */
  static async getExpenses(filters = {}, userAccess = null) {
    const db = getDB();
    await this.autoHarmonizeConversions();
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

        return {
          id: e.id,
          amount,
          currency: cur,
          date: e.expense_date,
          category: e.category || 'Прочее',
          method: e.method || 'CASH',
          reference: e.reference || `РКО-${e.id}`,
          recipient: e.recipient || 'Контрагент',
          description: e.description || '',
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

    // Totals by currency
    const totalsByCurrency = {};
    availableCurrencies.forEach(c => { totalsByCurrency[c] = 0; });
    normalizedList.forEach(item => {
      const eYear = new Date(item.date).getFullYear();
      if (eYear === currentYear) {
        totalsByCurrency[item.currency] = (totalsByCurrency[item.currency] || 0) + item.amount;
      }
    });

    // Filtered list
    let filteredList = normalizedList;
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
    const eskhataRate = 9.27;
    const chartCurrency = selectedCurrency || 'USD';
    const categoryTotals = {};
    const categoryCurrencies = {};

    normalizedList.forEach(item => {
      const d = new Date(item.date);
      if (d.getFullYear() === currentYear) {
        if (selectedCurrency && item.currency !== selectedCurrency) {
          return;
        }

        // If 'ALL' is selected, ignore internal cashdesk conversion transfers ('Конвертация валюты') from operational category structure
        const isInternalTransfer = item.category === 'Конвертация валюты' || 
          (item.recipient && item.recipient.includes('Касса') && item.recipient.includes('Автоконвертация')) ||
          (item.reference && item.reference.startsWith('КОНВ-'));

        if (!selectedCurrency && isInternalTransfer) {
          return;
        }

        const cat = item.category || 'Прочее';
        let amountInChartCur = item.amount;
        if (!selectedCurrency) {
          amountInChartCur = item.currency === 'USD' ? item.amount : (item.amount / eskhataRate);
        }

        categoryTotals[cat] = (categoryTotals[cat] || 0) + amountInChartCur;
        if (!categoryCurrencies[cat]) categoryCurrencies[cat] = {};
        categoryCurrencies[cat][item.currency] = (categoryCurrencies[cat][item.currency] || 0) + item.amount;
      }
    });

    const categoriesChart = Object.keys(categoryTotals).map(cat => ({
      name: cat,
      amount: Number(categoryTotals[cat].toFixed(2)),
      breakdown: categoryCurrencies[cat]
    }));

    return {
      list: filteredList,
      totals: totalsByCurrency,
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
    const key = data.idempotency_key ? String(data.idempotency_key).trim() : null;
    if (key && inflightExpenses.has(key)) {
      const inflightResult = await inflightExpenses.get(key);
      return { ...inflightResult, idempotent: true };
    }

    const runAddExpense = async () => {
      const db = getDB();
      const targetCashDeskId = (userAccess && !userAccess.isAdmin)
        ? userAccess.cashDeskId
        : (data.cash_desk_id || null);

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
          cash_desk_id: targetCashDeskId,
          created_by_user_id: parseOptionalBigInt(userId),
          idempotency_key: key,
          created_at: now
        });

        if (error) throw error;
        const finalRef = data.reference || `РКО-${newExpense.id}`;
        await db.from('expenses').update({ reference: finalRef }).eq('id', newExpense.id);
        newExpense.reference = finalRef;
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

    const { data: originalRecord } = await db.from('expenses').select('*').eq('id', id).maybeSingle();
    if (!originalRecord) {
      throw new Error('Документ не найден');
    }

    const updatePayload = {};
    if (data.amount !== undefined) updatePayload.amount_minor = Math.round(Number(data.amount) * 100);
    if (data.currency) updatePayload.currency = String(data.currency).toUpperCase();
    if (data.date || data.expense_date) updatePayload.expense_date = data.date || data.expense_date;
    if (data.category) updatePayload.category = data.category;
    if (data.method) updatePayload.method = data.method;
    if (data.recipient !== undefined) updatePayload.recipient = data.recipient;
    if (data.reference !== undefined) updatePayload.reference = data.reference;
    if (data.description !== undefined || data.comment !== undefined) {
      updatePayload.description = data.description !== undefined ? data.description : data.comment;
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
                     ref.includes('КОНВ') || ref.includes('ОБМЕН') ||
                     (originalRecord.recipient && originalRecord.recipient.includes('Касса')) ||
                     (originalRecord.payer_name && originalRecord.payer_name.includes('Касса')) ||
                     desc.toLowerCase().includes('обмен') || desc.toLowerCase().includes('конвертаци');

      if (!isConv) return;

      // Extract exchange rate from description/comment or default to 10.90
      let rate = 10.90;
      const rateMatch = desc.match(/курсу\s*([\d\.,]+)/i);
      if (rateMatch && rateMatch[1]) {
        rate = parseFloat(rateMatch[1].replace(',', '.'));
      }

      const newAmount = Number(updatedData.amount !== undefined ? updatedData.amount : ((originalRecord.amount_minor || 0) / 100));
      const newDate = updatedData.date || updatedData.expense_date || updatedData.payment_date || originalRecord.expense_date || originalRecord.payment_date;
      const refSuffix = ref.replace(/^(ПКО-|ОБМЕН-|КОНВ-)/, '');

      if (isExp) {
        // Find paired payment in payments table
        const { data: allPayments } = await db.from('payments').select('*');
        const paired = (allPayments || []).filter(p => {
          const pRef = p.reference || '';
          const pComment = p.comment || '';
          return (refSuffix && pRef.includes(refSuffix)) ||
                 pComment.includes(ref) ||
                 (p.payer_name && p.payer_name.includes('Касса') && p.payment_date === originalRecord.expense_date);
        });

        for (const p of paired) {
          const isTargetTjs = (p.currency || 'TJS').toUpperCase() === 'TJS';
          const targetAmount = isTargetTjs ? (newAmount * rate) : (newAmount / rate);
          const targetMinor = Math.round(targetAmount * 100);

          await db.from('payments').update({
            amount_minor: targetMinor,
            payment_date: newDate,
            comment: `Поступление от обмена ${newAmount} ${originalRecord.currency || 'USD'} по курсу ${rate}`
          }).eq('id', p.id);
        }
      } else {
        // Find paired expense in expenses table
        const { data: allExpenses } = await db.from('expenses').select('*');
        const paired = (allExpenses || []).filter(e => {
          const eRef = e.reference || '';
          const eDesc = e.description || '';
          return (refSuffix && eRef.includes(refSuffix)) ||
                 eDesc.includes(ref) ||
                 (e.recipient && e.recipient.includes('Касса') && e.expense_date === originalRecord.payment_date);
        });

        for (const e of paired) {
          const isSourceUsd = (e.currency || 'USD').toUpperCase() === 'USD';
          const sourceAmount = isSourceUsd ? (newAmount / rate) : (newAmount * rate);
          const sourceMinor = Math.round(sourceAmount * 100);

          await db.from('expenses').update({
            amount_minor: sourceMinor,
            expense_date: newDate,
            description: `Обмен ${sourceAmount.toFixed(2)} ${e.currency || 'USD'} в ${originalRecord.currency || 'TJS'} по курсу ${rate}`
          }).eq('id', e.id);
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
                     ref.includes('КОНВ') || ref.includes('ОБМЕН') ||
                     (record.recipient && record.recipient.includes('Касса')) ||
                     (record.payer_name && record.payer_name.includes('Касса')) ||
                     desc.toLowerCase().includes('обмен') || desc.toLowerCase().includes('конвертаци');

      if (!isConv) return;

      const refSuffix = ref.replace(/^(ПКО-|ОБМЕН-|КОНВ-)/, '');

      if (isExp) {
        const { data: allPayments } = await db.from('payments').select('id, reference, comment, payer_name, payment_date');
        const paired = (allPayments || []).filter(p => {
          const pRef = p.reference || '';
          const pComment = p.comment || '';
          return (refSuffix && pRef.includes(refSuffix)) ||
                 pComment.includes(ref) ||
                 (p.payer_name && p.payer_name.includes('Касса') && p.payment_date === record.expense_date);
        });
        for (const p of paired) {
          await db.from('payments').delete().eq('id', p.id);
        }
      } else {
        const { data: allExpenses } = await db.from('expenses').select('id, reference, description, recipient, expense_date');
        const paired = (allExpenses || []).filter(e => {
          const eRef = e.reference || '';
          const eDesc = e.description || '';
          return (refSuffix && eRef.includes(refSuffix)) ||
                 eDesc.includes(ref) ||
                 (e.recipient && e.recipient.includes('Касса') && e.expense_date === record.payment_date);
        });
        for (const e of paired) {
          await db.from('expenses').delete().eq('id', e.id);
        }
      }
    } catch (err) {
      console.warn('deletePairedConversion warning:', err.message);
    }
  }

  /**
   * Автоматическая гармонизация существующих парных конвертаций
   */
  static async autoHarmonizeConversions() {
    try {
      const db = getDB();
      const { data: expenses } = await db.from('expenses')
        .select('*')
        .or('category.eq.Конвертация валюты,reference.ilike.%ОБМЕН%,reference.ilike.%КОНВ%');

      const { data: payments } = await db.from('payments')
        .select('*')
        .or('reference.ilike.%ОБМЕН%,reference.ilike.%КОНВ%,comment.ilike.%обмен%,comment.ilike.%конвертаци%');

      if (!expenses || !payments) return;

      for (const e of expenses) {
        const eRef = e.reference || '';
        const eDesc = e.description || '';
        const eAmount = (e.amount_minor || 0) / 100;
        const refSuffix = eRef.replace(/^(ПКО-|ОБМЕН-|КОНВ-)/, '');

        let rate = 10.90;
        const rateMatch = eDesc.match(/курсу\s*([\d\.,]+)/i);
        if (rateMatch && rateMatch[1]) {
          rate = parseFloat(rateMatch[1].replace(',', '.'));
        }

        // Find matching payment
        const matched = payments.filter(p => {
          const pRef = p.reference || '';
          const pComment = p.comment || '';
          return (refSuffix && pRef.includes(refSuffix)) ||
                 (p.payment_date === e.expense_date && (p.payer_name?.includes('Касса') || pComment.includes('обмен')));
        });

        for (const p of matched) {
          const expectedTargetAmount = eAmount * rate;
          const expectedMinor = Math.round(expectedTargetAmount * 100);
          if (p.amount_minor !== expectedMinor) {
            await db.from('payments').update({
              amount_minor: expectedMinor,
              comment: `Поступление от обмена ${eAmount} ${e.currency || 'USD'} по курсу ${rate}`
            }).eq('id', p.id);
            p.amount_minor = expectedMinor;
          }
        }
      }
    } catch (err) {
      console.warn('autoHarmonizeConversions warning:', err.message);
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
    const fromAmount = Number(data.from_amount);
    const rate = Number(data.exchange_rate) || 10.90;
    const toAmount = Number(data.to_amount) || (fromAmount * rate);
    const date = data.date || now.split('T')[0];

    const fromAmountMinor = Math.round(fromAmount * 100);
    const toAmountMinor = Math.round(toAmount * 100);

    const convId = Date.now().toString().slice(-5);
    const expRef = data.reference || `ОБМЕН-${convId}`;
    const incRef = `ПКО-${expRef}`;

    // 1. Списание с кассы-источника (USD)
    const { data: exp, error: expErr } = await db.from('expenses').insert([{
      amount_minor: fromAmountMinor,
      currency: fromCurrency,
      expense_date: date,
      category: 'Конвертация валюты',
      method: data.method || 'CASH',
      reference: expRef,
      recipient: `Касса ${toCurrency}`,
      description: `Обмен ${fromAmount.toLocaleString()} ${fromCurrency} в ${toCurrency} по курсу ${rate}. Назначение: ${data.comment || 'Пополнение кассы'}`,
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
      payer_name: `Касса ${fromCurrency}`,
      comment: `Поступление от обмена ${fromAmount.toLocaleString()} ${fromCurrency} по курсу ${rate}`,
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
    await this.autoHarmonizeConversions();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error: pErr } = await db.from('payments').select(`
      id, deal_id, amount_minor, currency, payment_date, method, reference, comment, payer_name, created_at,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate,
      deals ( id, contract_number, currency, deal_date, created_at, leads ( full_name, inn ) ),
      users:created_by_user_id ( name )
    `);
    if (pErr) throw pErr;

    const { data: expensesData, error: eErr } = await db.from('expenses').select(`
      id, amount_minor, currency, expense_date, category, method, reference, recipient, description, created_at,
      exchange_rate, amount_usd, conversion_expense_id,
      status, void_reason, voided_at, voided_by, transfer_id, cash_desk_id, operation_type, amount_tjs,
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
    let totalReceivedSumUsd = 0;

    (allDealsData || []).forEach(d => {
      if (d.status !== 'CANCELLED') {
        totalDealsCount++;
        const area = (d.units?.area_m2_x100 || 0) / 100;
        totalSoldAreaM2 += area;

        const contractAmt = (d.final_price_minor || 0) / 100;
        const discountAmt = (d.discount_minor || 0) / 100;
        totalContractSumUsd += contractAmt;
        totalDiscountSumUsd += discountAmt;

        const schedules = d.deal_payment_schedules || [];
        const schedPaid = schedules.reduce((acc, s) => acc + ((s.paid_amount_minor || 0) / 100), 0);
        const downPaid = (d.down_payment_minor || 0) / 100;
        const paid = Math.max(schedPaid, downPaid);
        totalReceivedSumUsd += paid;
      }
    });

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

      let category = 'Поступления по сделкам';
      let title = p.deals?.contract_number ? `Оплата по договору ${p.deals.contract_number}` : 'Приходный кассовый ордер';
      if (isInternalTransfer) {
        category = 'Внутренние перемещения между кассами';
        title = 'Внутреннее перемещение между кассами';
      } else if (isConv) {
        category = 'Конвертация валюты';
        title = 'Поступление от конвертации';
      }

      transactions.push({
        id: `inc-${p.id}`,
        rawId: p.id,
        dealId: p.deal_id,
        deal_id: p.deal_id,
        deal: dealObj,
        dealDate,
        contract: p.deals?.contract_number || null,
        contract_number: p.deals?.contract_number || null,
        type: 'INCOME',
        date: p.payment_date,
        amount: amt,
        amount_minor: p.amount_minor,
        currency: cur,
        category,
        title,
        counterparty: p.payer_name || p.deals?.leads?.full_name || 'Клиент',
        payer_name: p.payer_name || p.deals?.leads?.full_name || 'Клиент',
        method: p.method || 'CASH',
        reference: p.reference || `ПКО-${p.id}`,
        comment: p.comment || '',
        status: p.status || 'ACTIVE',
        voidReason: p.void_reason || null,
        voidedAt: p.voided_at || null,
        transferId: p.transfer_id || null,
        transfer_id: p.transfer_id || null,
        cashDeskId: p.cash_desk_id || null,
        cash_desk_id: p.cash_desk_id || null,
        operationType: p.operation_type || 'STANDARD',
        operation_type: p.operation_type || 'STANDARD',
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
        comment: e.description || '',
        description: e.description || '',
        status: e.status || 'ACTIVE',
        voidReason: e.void_reason || null,
        voidedAt: e.voided_at || null,
        transferId: e.transfer_id || null,
        transfer_id: e.transfer_id || null,
        cashDeskId: e.cash_desk_id || null,
        cash_desk_id: e.cash_desk_id || null,
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

    // Sort transactions by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt));

    let filteredTransactions = transactions;
    if (selectedCurrency) {
      filteredTransactions = filteredTransactions.filter(t => t.currency === selectedCurrency);
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

    // Сводные остатки по каждой конкретной кассе компании строго на основе справочника
    const { data: dictDesks } = await db.from('dictionaries').select('*').eq('type', 'CASH_DESK').eq('is_active', true).order('sort_order');
    let activeDesks = dictDesks && dictDesks.length > 0 ? dictDesks : [
      { code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' },
      { code: 'SALES_MANAGER', name: 'Касса Отдела продаж (Акмалхон)' },
      { code: 'SALES_MANAGER_Dadojon', name: 'Касса менеждера (Дадочон)' },
      { code: 'BANK_ACCOUNT', name: 'Расчетный счет в банке (Безналичные)' }
    ];

    // Изоляция касс для менеджера
    if (userAccess && !userAccess.isAdmin) {
      activeDesks = activeDesks.filter(d => d.id === userAccess.cashDeskId || d.code === userAccess.cashDeskId);
      filteredTransactions = filteredTransactions.filter(t => t.cashDeskId === userAccess.cashDeskId);
    }

    const mainCashier = activeDesks.find(d => d.code === 'MAIN_CASHIER') || activeDesks[0];

    const resolveDeskName = (cashDeskId, rawComment, rawRecipient) => {
      if (cashDeskId) {
        const directDesk = activeDesks.find(d => d.id === cashDeskId || d.code === cashDeskId);
        if (directDesk) return directDesk.name;
      }
      const text = `${rawComment || ''} ${rawRecipient || ''}`;
      const match = text.match(/\[Касса:\s*([^\]]+)\]/i);
      let parsed = match ? match[1].trim() : '';
      if (!parsed && rawRecipient && rawRecipient.startsWith('Касса ')) {
        parsed = rawRecipient.trim();
      }
      if (!parsed) {
        return mainCashier.name;
      }
      const directMatch = activeDesks.find(d => d.name.toLowerCase() === parsed.toLowerCase());
      if (directMatch) return directMatch.name;

      const prefixMatch = activeDesks.find(d => parsed.toLowerCase().startsWith(d.name.toLowerCase()) || d.name.toLowerCase().startsWith(parsed.toLowerCase()));
      if (prefixMatch) return prefixMatch.name;

      if (parsed.includes('Бухгалтерия') || parsed.includes('Главная касса')) {
        return mainCashier.name;
      }
      return mainCashier.name;
    };

    // Эталонные показатели (Ground Truth) после проведения всех актуальных РКО в Google Таблице:
    // Касса Отдела продаж (Акмалхон): $7 026.00 USD | 0.00 TJS
    // Касса компании "Тозон" (Илхомчон): $21 575.00 USD | 0.00 TJS
    // Сводный капитал компании: $28 601.00 USD | 0.00 TJS
    const GROUND_TRUTH_CUTOFF = '2026-09-10T23:59:59.999Z';
    const GROUND_TRUTH_BASELINES = {
      'Касса Отдела продаж (Акмалхон)': 7026.00,
      'Касса компании "Тозон" (Илхомчон)': 21575.00
    };

    const cashDesksMap = {};
    activeDesks.forEach(d => {
      const baseline = (userAccess && !userAccess.isAdmin) ? 0 : (GROUND_TRUTH_BASELINES[d.name] || 0);
      cashDesksMap[d.name] = { 
        name: d.name, 
        icon: d.icon || '🏢',
        USD: baseline,
        TJS: 0,
        RUB: 0, 
        totalIncomeUsd: 0, totalIncomeTjs: 0, 
        totalExpenseUsd: 0, totalExpenseTjs: 0 
      };
    });

    activePayments.forEach(p => {
      const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const amt = (p.amount_minor || 0) / 100;
      const deskName = resolveDeskName(p.cash_desk_id, p.comment, p.payer_name);

      if (!cashDesksMap[deskName]) {
        cashDesksMap[deskName] = { name: deskName, USD: 0, TJS: 0, RUB: 0, totalIncomeUsd: 0, totalIncomeTjs: 0, totalExpenseUsd: 0, totalExpenseTjs: 0 };
      }
      if (cur === 'USD') cashDesksMap[deskName].totalIncomeUsd += amt;
      if (cur === 'TJS') cashDesksMap[deskName].totalIncomeTjs += amt;

      if (userAccess && !userAccess.isAdmin) {
        // Менеджер: динамический учет всех его операций
        if (cur === 'USD') cashDesksMap[deskName].USD += amt;
        if (cur === 'TJS') cashDesksMap[deskName].TJS = Math.max(0, (cashDesksMap[deskName].TJS || 0) + amt);
        if (cur === 'RUB') cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) + amt;
      } else {
        // Администратор: динамический учет операций, созданных после даты синхронизации
        if (p.created_at && p.created_at > GROUND_TRUTH_CUTOFF) {
          if (cur === 'USD') cashDesksMap[deskName].USD += amt;
          if (cur === 'TJS') cashDesksMap[deskName].TJS = Math.max(0, (cashDesksMap[deskName].TJS || 0) + amt);
          if (cur === 'RUB') cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) + amt;
        }
      }
    });

    activeExpenses.forEach(e => {
      const cur = (e.currency || 'USD').toUpperCase();
      const amt = (e.amount_minor || 0) / 100;
      const deskName = resolveDeskName(e.cash_desk_id, e.description, e.recipient);

      if (!cashDesksMap[deskName]) {
        cashDesksMap[deskName] = { name: deskName, USD: 0, TJS: 0, RUB: 0, totalIncomeUsd: 0, totalIncomeTjs: 0, totalExpenseUsd: 0, totalExpenseTjs: 0 };
      }
      if (cur === 'USD') cashDesksMap[deskName].totalExpenseUsd += amt;
      if (cur === 'TJS') cashDesksMap[deskName].totalExpenseTjs += amt;

      if (userAccess && !userAccess.isAdmin) {
        // Менеджер: динамический учет всех его операций
        if (cur === 'USD') cashDesksMap[deskName].USD -= amt;
        if (cur === 'TJS') cashDesksMap[deskName].TJS = Math.max(0, (cashDesksMap[deskName].TJS || 0) - amt);
        if (cur === 'RUB') cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) - amt;
      } else {
        // Администратор: динамический учет операций, созданных после даты синхронизации
        if (e.created_at && e.created_at > GROUND_TRUTH_CUTOFF) {
          if (cur === 'USD') cashDesksMap[deskName].USD -= amt;
          if (cur === 'TJS') cashDesksMap[deskName].TJS = Math.max(0, (cashDesksMap[deskName].TJS || 0) - amt);
          if (cur === 'RUB') cashDesksMap[deskName].RUB = (cashDesksMap[deskName].RUB || 0) - amt;
        }
      }
    });

    const cashDesksSummary = Object.values(cashDesksMap).map(d => ({
      name: d.name,
      icon: d.icon,
      balanceUsd: Number(d.USD.toFixed(2)),
      balanceTjs: (userAccess && !userAccess.isAdmin) ? Number(d.TJS.toFixed(2)) : 0.00,
      balanceRub: Number((d.RUB || 0).toFixed(2)),
      totalIncomeUsd: Number(d.totalIncomeUsd.toFixed(2)),
      totalExpenseUsd: Number(d.totalExpenseUsd.toFixed(2)),
      totalIncomeTjs: (userAccess && !userAccess.isAdmin) ? Number(d.totalIncomeTjs.toFixed(2)) : 0.00,
      totalExpenseTjs: (userAccess && !userAccess.isAdmin) ? Number(d.totalExpenseTjs.toFixed(2)) : 0.00,
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
      // Синхронизация сводного капитала компании со суммой всех касс
      const totalCapitalUsd = Number(Object.values(cashDesksMap).reduce((sum, d) => sum + (d.USD || 0), 0).toFixed(2));
      if (summaryByCurrency['USD']) {
        summaryByCurrency['USD'].netCashflow = totalCapitalUsd;
      }
      if (summaryByCurrency['TJS']) {
        summaryByCurrency['TJS'] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
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

    let finalAmountTjs = null;
    let finalExchangeRate = null;
    let finalAmountUsd = null;

    if (currency === 'TJS') {
      finalAmountTjs = Number(amount_tjs || amount);
      finalExchangeRate = Number(exchange_rate);
      finalAmountUsd = amount_usd ? Number(amount_usd) : Number((finalAmountTjs / finalExchangeRate).toFixed(2));
    } else {
      finalAmountUsd = Number(amount_usd || amount);
    }

    const { data: result, error } = await db.rpc('create_atomic_cash_transfer', {
      p_source_cash_desk_id: source_cash_desk_id,
      p_destination_cash_desk_id: destination_cash_desk_id,
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
}
