import { getDB } from '../../db/connection.js';

export class FinanceRepository {
  /**
   * Получить список доходов (платежей)
   */
  static async getIncome(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();

    const { data: payments, error } = await db.from('payments').select(`
      id, amount_minor, payment_date, method, comment, created_at,
      deals ( contract_number, leads ( full_name ) )
    `).order('payment_date', { ascending: false });

    if (error) throw error;

    let income = payments || [];
    
    // Aggregate by month for the selected year
    const monthlyIncome = Array(12).fill(0);
    income.forEach(p => {
      const pDate = new Date(p.payment_date);
      if (pDate.getFullYear() === currentYear) {
        monthlyIncome[pDate.getMonth()] += (p.amount_minor || 0) / 100;
      }
    });

    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    
    const chartData = monthNames.map((month, idx) => ({
      month,
      amount: Number(monthlyIncome[idx].toFixed(2))
    }));

    return {
      list: income.map(p => ({
        id: p.id,
        amount: (p.amount_minor || 0) / 100,
        date: p.payment_date,
        method: p.method,
        comment: p.comment,
        contract: p.deals?.contract_number || '-',
        clientName: p.deals?.leads?.full_name || 'Неизвестно',
      })),
      chartData
    };
  }

  /**
   * Получить список расходов
   */
  static async getExpenses(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();

    const { data: expensesData, error } = await db.from('expenses').select(`
      id, amount_minor, expense_date, category, description, created_at
    `).order('expense_date', { ascending: false });

    if (error) throw error;

    const expenses = expensesData || [];
    
    const categoryTotals = {};
    const monthlyExpenses = Array(12).fill(0);

    expenses.forEach(e => {
      const amount = (e.amount_minor || 0) / 100;
      const eDate = new Date(e.expense_date);
      
      if (eDate.getFullYear() === currentYear) {
        monthlyExpenses[eDate.getMonth()] += amount;
      }
      
      const cat = e.category || 'Прочее';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
    });

    const categoriesChart = Object.keys(categoryTotals).map(cat => ({
      name: cat,
      amount: Number(categoryTotals[cat].toFixed(2))
    }));

    return {
      list: expenses.map(e => ({
        id: e.id,
        amount: (e.amount_minor || 0) / 100,
        date: e.expense_date,
        category: e.category,
        description: e.description,
      })),
      categoriesChart
    };
  }

  /**
   * Добавить расход
   */
  static async addExpense(expenseData, userId) {
    const db = getDB();
    const { amount, date, category, description } = expenseData;

    const { data, error } = await db.from('expenses').insert({
      amount_minor: Math.round(amount * 100),
      expense_date: date,
      category,
      description,
      created_by_user_id: userId
    }).select().single();

    if (error) throw error;
    return data;
  }

  /**
   * Получить ДДС (Cashflow)
   */
  static async getCashflow(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();

    const { data: payments, error: pErr } = await db.from('payments').select('amount_minor, payment_date');
    if (pErr) throw pErr;

    const { data: expenses, error: eErr } = await db.from('expenses').select('amount_minor, expense_date');
    if (eErr) throw eErr;

    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];

    const monthlyData = monthNames.map(month => ({ month, income: 0, expense: 0, net: 0 }));
    let totalIncome = 0;
    let totalExpense = 0;

    (payments || []).forEach(p => {
      const date = new Date(p.payment_date);
      if (date.getFullYear() === currentYear) {
        const amount = (p.amount_minor || 0) / 100;
        monthlyData[date.getMonth()].income += amount;
        totalIncome += amount;
      }
    });

    (expenses || []).forEach(e => {
      const date = new Date(e.expense_date);
      if (date.getFullYear() === currentYear) {
        const amount = (e.amount_minor || 0) / 100;
        monthlyData[date.getMonth()].expense += amount;
        totalExpense += amount;
      }
    });

    monthlyData.forEach(m => {
      m.income = Number(m.income.toFixed(2));
      m.expense = Number(m.expense.toFixed(2));
      m.net = Number((m.income - m.expense).toFixed(2));
    });

    return {
      monthlyData,
      summary: {
        totalIncome: Number(totalIncome.toFixed(2)),
        totalExpense: Number(totalExpense.toFixed(2)),
        netCashflow: Number((totalIncome - totalExpense).toFixed(2))
      }
    };
  }
}
