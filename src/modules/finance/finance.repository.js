import { getDB } from '../../db/connection.js';

export class FinanceRepository {
  /**
   * Получить список доходов (приходных ордеров и платежей)
   */
  static async getIncome(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;

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

    // Monthly Chart Data (for currentYear and selectedCurrency or primary currency)
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

    // Categories Breakdown Chart for chartCurrency
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
      categoriesChart,
      chartCurrency
    };
  }

  /**
   * Добавить расходный кассовый ордер
   */
  static async addExpense(data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const amountMinor = Math.round(Number(data.amount) * 100);
    const expenseDate = data.date || data.expense_date || now.split('T')[0];
    const currency = (data.currency || 'USD').toUpperCase();

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
   * Получить ДДС (Движение Денежных Средств) со сводкой по валютам и полным журналом
   */
  static async getCashflow(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();
    const selectedCurrency = filters.currency && filters.currency !== 'ALL' ? filters.currency : null;

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

    // Monthly Data for chartCurrency
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
      transactions.push({
        id: `inc-${p.id}`,
        rawId: p.id,
        type: 'INCOME',
        date: p.payment_date,
        amount: amt,
        currency: cur,
        category: 'Поступления по сделкам',
        title: p.deals?.contract_number ? `Оплата по договору ${p.deals.contract_number}` : 'Приходный кассовый ордер',
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
      transactions.push({
        id: `exp-${e.id}`,
        rawId: e.id,
        type: 'EXPENSE',
        date: e.expense_date,
        amount: amt,
        currency: cur,
        category: e.category || 'Прочее',
        title: `Расход: ${e.category || 'Прочее'}`,
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
      monthlyData,
      chartCurrency,
      transactions: filteredTransactions
    };
  }
}
