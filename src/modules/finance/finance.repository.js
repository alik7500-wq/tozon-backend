import { getDB } from '../../db/connection.js';

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
    const { data: payments } = await db.from('payments').select('payment_date');
    (payments || []).forEach(p => {
      if (p.payment_date) {
        const y = new Date(p.payment_date).getFullYear();
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
  static async getIncome(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error } = await db.from('payments').select(`
      id, deal_id, schedule_id, amount_minor, currency, payment_date, method, reference, comment, payer_name, created_at,
      deals ( id, contract_number, currency, final_price_minor, leads ( full_name, phone ) ),
      users ( id, name )
    `).order('payment_date', { ascending: false });

    if (error) throw error;

    const allPayments = paymentsData || [];
    
    // Normalize and extract currency for each payment
    const normalizedList = allPayments.map(p => {
      const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const amount = (p.amount_minor || 0) / 100;
      const clientName = p.payer_name || p.deals?.leads?.full_name || (p.deal_id ? `Клиент по сделке #${p.deal_id}` : 'Прямой плательщик');
      const contract = p.deals?.contract_number || (p.deal_id ? `СД-${p.deal_id}` : 'Прямой приход');

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
        clientName,
        clientPhone: p.deals?.leads?.phone || '',
        createdByName: p.users?.name || 'Система',
        createdAt: p.created_at,
      };
    });

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
    const chartCurrency = selectedCurrency || (availableCurrencies[0] || 'USD');
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    
    const monthlyIncome = Array(12).fill(0);
    normalizedList.forEach(item => {
      const d = new Date(item.date);
      if (d.getFullYear() === currentYear && item.currency === chartCurrency) {
        monthlyIncome[d.getMonth()] += item.amount;
      }
    });

    const chartData = monthNames.map((month, idx) => ({
      month,
      amount: Number(monthlyIncome[idx].toFixed(2)),
      currency: chartCurrency
    }));

    return {
      list: filteredList,
      totalsByCurrency,
      availableCurrencies,
      availableYears,
      chartData,
      chartCurrency
    };
  }

  /**
   * Добавить приходный кассовый ордер (доход)
   */
  static async addIncome(data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const amountMinor = Math.round(Number(data.amount) * 100);
    const paymentDate = data.date || data.payment_date || now.split('T')[0];
    const currency = (data.currency || 'USD').toUpperCase();
    const dealId = data.deal_id ? Number(data.deal_id) : null;
    const scheduleId = data.schedule_id ? Number(data.schedule_id) : null;

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
      created_by_user_id: userId || null,
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
   * Получить список расходов (расходных ордеров)
   */
  static async getExpenses(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: expensesData, error } = await db.from('expenses').select(`
      id, amount_minor, currency, expense_date, category, method, reference, recipient, description, created_at,
      users ( id, name )
    `).order('expense_date', { ascending: false });

    if (error) throw error;

    const allExpenses = expensesData || [];
    
    const normalizedList = allExpenses.map(e => {
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
        createdByName: e.users?.name || 'Администратор',
        createdAt: e.created_at
      };
    });

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
    const chartCurrency = selectedCurrency || (availableCurrencies[0] || 'USD');
    const categoryTotals = {};
    normalizedList.forEach(item => {
      const d = new Date(item.date);
      if (d.getFullYear() === currentYear && item.currency === chartCurrency) {
        categoryTotals[item.category] = (categoryTotals[item.category] || 0) + item.amount;
      }
    });

    const categoriesChart = Object.keys(categoryTotals).map(cat => ({
      name: cat,
      amount: Number(categoryTotals[cat].toFixed(2))
    }));

    return {
      list: filteredList,
      totalsByCurrency,
      availableCurrencies,
      availableYears,
      categoriesChart,
      chartCurrency
    };
  }

  /**
   * Добавить расходный кассовый ордер (с поддержкой автоконвертации)
   */
  static async addExpense(data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const amountMinor = Math.round(Number(data.amount) * 100);
    const expenseDate = data.date || data.expense_date || now.split('T')[0];
    const currency = (data.currency || 'USD').toUpperCase();
    const autoConvert = data.auto_convert !== undefined ? Boolean(data.auto_convert) : (currency === 'TJS');
    const exchangeRate = Number(data.exchange_rate) || 10.90;
    const sourceCurrency = (data.source_currency || 'USD').toUpperCase();

    // Если включена автоконвертация (например, расход в TJS, а средства списываются с USD)
    if (autoConvert && currency !== sourceCurrency) {
      let convertedSourceAmount = 0;
      if (currency === 'TJS' && sourceCurrency === 'USD') {
        convertedSourceAmount = Number(data.amount) / exchangeRate;
      } else if (currency === 'USD' && sourceCurrency === 'TJS') {
        convertedSourceAmount = Number(data.amount) * exchangeRate;
      } else {
        convertedSourceAmount = Number(data.amount) / exchangeRate;
      }

      const sourceMinor = Math.round(convertedSourceAmount * 100);

      // 1. Списание сконвертированной суммы с исходной кассы (USD)
      await db.from('expenses').insert([{
        amount_minor: sourceMinor,
        currency: sourceCurrency,
        expense_date: expenseDate,
        category: 'Конвертация валюты',
        method: data.method || 'CASH',
        reference: `КОНВ-${Date.now().toString().slice(-5)}`,
        recipient: `Касса ${currency} (Автоконвертация)`,
        description: `Автоконвертация $${convertedSourceAmount.toFixed(2)} ${sourceCurrency} по курсу ${exchangeRate} в ${currency} для расхода: ${data.description || data.category || data.recipient || 'РКО'}`,
        created_by_user_id: userId || null,
        created_at: now
      }]);

      // 2. Зачисление сконвертированных средств в кассу назначения (TJS)
      await db.from('payments').insert([{
        amount_minor: amountMinor,
        currency: currency,
        payment_date: expenseDate,
        method: data.method || 'CASH',
        reference: `ПКО-КОНВ-${Date.now().toString().slice(-5)}`,
        payer_name: `Касса ${sourceCurrency} (Автоконвертация)`,
        comment: `Поступление от автоконвертации $${convertedSourceAmount.toFixed(2)} ${sourceCurrency} по курсу ${exchangeRate} для расхода: ${data.description || data.category || data.recipient || 'РКО'}`,
        created_by_user_id: userId || null,
        created_at: now
      }]);
    }

    // 3. Регистрация самого расхода в кассе (TJS / USD)
    const { data: newExpense, error } = await db.from('expenses').insert([{
      amount_minor: amountMinor,
      currency,
      expense_date: expenseDate,
      category: data.category || 'Прочее',
      method: data.method || 'CASH',
      reference: data.reference || `РКО-${Date.now().toString().slice(-6)}`,
      recipient: data.recipient || null,
      description: data.description || null,
      created_by_user_id: userId || null,
      created_at: now
    }]).select().single();

    if (error) throw error;
    return newExpense;
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

    // 1. Списание с кассы-источника (USD)
    const { data: exp, error: expErr } = await db.from('expenses').insert([{
      amount_minor: fromAmountMinor,
      currency: fromCurrency,
      expense_date: date,
      category: 'Конвертация валюты',
      method: data.method || 'CASH',
      reference: data.reference || `ОБМЕН-${Date.now().toString().slice(-5)}`,
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
      reference: `ПКО-ОБМЕН-${Date.now().toString().slice(-5)}`,
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
  static async getCashflow(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;
    const availableYears = await this.getAvailableYears();

    const { data: paymentsData, error: pErr } = await db.from('payments').select(`
      id, deal_id, amount_minor, currency, payment_date, method, reference, comment, payer_name, created_at,
      deals ( contract_number, currency, leads ( full_name ) ),
      users ( name )
    `);
    if (pErr) throw pErr;

    const { data: expensesData, error: eErr } = await db.from('expenses').select(`
      id, amount_minor, currency, expense_date, category, method, reference, recipient, description, created_at,
      users ( name )
    `);
    if (eErr) throw eErr;

    // Collect all currencies
    const currencySet = new Set(['USD', 'TJS']);
    (paymentsData || []).forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      currencySet.add(c);
    });
    (expensesData || []).forEach(e => {
      const c = (e.currency || 'USD').toUpperCase();
      currencySet.add(c);
    });
    const availableCurrencies = Array.from(currencySet);

    // Summary per currency
    const summaryByCurrency = {};
    availableCurrencies.forEach(c => {
      summaryByCurrency[c] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
    });

    (paymentsData || []).forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const d = new Date(p.payment_date);
      if (d.getFullYear() === currentYear) {
        const amt = (p.amount_minor || 0) / 100;
        if (!summaryByCurrency[c]) summaryByCurrency[c] = { totalIncome: 0, totalExpense: 0, netCashflow: 0 };
        summaryByCurrency[c].totalIncome += amt;
      }
    });

    (expensesData || []).forEach(e => {
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

    (expensesData || []).forEach(e => {
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

    (paymentsData || []).forEach(p => {
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

    (paymentsData || []).forEach(p => {
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

    (expensesData || []).forEach(e => {
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
    const chartCurrency = selectedCurrency || (availableCurrencies[0] || 'USD');
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    const monthlyData = monthNames.map(month => ({ month, income: 0, expense: 0, net: 0 }));

    (paymentsData || []).forEach(p => {
      const c = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const d = new Date(p.payment_date);
      if (d.getFullYear() === currentYear && c === chartCurrency) {
        monthlyData[d.getMonth()].income += (p.amount_minor || 0) / 100;
      }
    });

    (expensesData || []).forEach(e => {
      const c = (e.currency || 'USD').toUpperCase();
      const d = new Date(e.expense_date);
      if (d.getFullYear() === currentYear && c === chartCurrency) {
        monthlyData[d.getMonth()].expense += (e.amount_minor || 0) / 100;
      }
    });

    monthlyData.forEach(m => {
      m.income = Number(m.income.toFixed(2));
      m.expense = Number(m.expense.toFixed(2));
      m.net = Number((m.income - m.expense).toFixed(2));
    });

    // Unified Cashflow Ledger (transactions)
    const transactions = [];

    (paymentsData || []).forEach(p => {
      const cur = (p.currency || p.deals?.currency || 'USD').toUpperCase();
      const amt = (p.amount_minor || 0) / 100;
      const isConv = (p.reference && p.reference.includes('КОНВ')) || (p.reference && p.reference.includes('ОБМЕН')) || (p.comment && p.comment.includes('конвертаци'));
      transactions.push({
        id: `inc-${p.id}`,
        rawId: p.id,
        type: 'INCOME',
        date: p.payment_date,
        amount: amt,
        currency: cur,
        category: isConv ? 'Конвертация валюты' : 'Поступления по сделкам',
        title: isConv ? 'Поступление от конвертации' : (p.deals?.contract_number ? `Оплата по договору ${p.deals.contract_number}` : 'Приходный кассовый ордер'),
        counterparty: p.payer_name || p.deals?.leads?.full_name || 'Клиент',
        method: p.method || 'CASH',
        reference: p.reference || `ПКО-${p.id}`,
        comment: p.comment || '',
        createdByName: p.users?.name || 'Система',
        createdAt: p.created_at
      });
    });

    (expensesData || []).forEach(e => {
      const cur = (e.currency || 'USD').toUpperCase();
      const amt = (e.amount_minor || 0) / 100;
      const isConv = e.category === 'Конвертация валюты' || (e.reference && e.reference.startsWith('КОНВ-')) || (e.reference && e.reference.startsWith('ОБМЕН-'));
      transactions.push({
        id: `exp-${e.id}`,
        rawId: e.id,
        type: 'EXPENSE',
        date: e.expense_date,
        amount: amt,
        currency: cur,
        category: e.category || 'Прочее',
        title: isConv ? 'Списание на конвертацию' : `Расход: ${e.category || 'Прочее'}`,
        counterparty: e.recipient || 'Контрагент',
        method: e.method || 'CASH',
        reference: e.reference || `РКО-${e.id}`,
        comment: e.description || '',
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

    return {
      summaryByCurrency,
      availableCurrencies,
      availableYears,
      conversionsSummary: {
        totalConvertedFromUsd: Number(totalConvertedFromUsd.toFixed(2)),
        totalConvertedToTjs: Number(totalConvertedToTjs.toFixed(2)),
        conversionOperationsCount
      },
      fxSummary: {
        avgIncomeRate: Number(avgIncomeRate.toFixed(2)),
        avgExpenseRate: Number(avgExpenseRate.toFixed(2)),
        totalTjsInflow: Number(totalTjsInflow.toFixed(2)),
        totalTjsOutflow: Number(totalTjsOutflow.toFixed(2)),
        fxGainLossUsd: Number(fxGainLossUsd.toFixed(2)),
        fxGainLossTjs: Number(fxGainLossTjs.toFixed(2)),
        isProfit: fxGainLossUsd >= 0
      },
      salesSummary,
      monthlyData,
      chartCurrency,
      transactions: filteredTransactions
    };
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
