import { connectDB, getDB } from '../db/connection.js';
import { FinanceRepository } from '../modules/finance/finance.repository.js';
import assert from 'assert';

connectDB();

const DESKS = [
  { key: 'ALL', name: 'Все кассы', id: null },
  { key: 'SALES_MANAGER', name: 'Отдел продаж (Акмалхон)', id: 'ab90800a-73af-4cf7-88c2-397c304e2edf' },
  { key: 'MAIN_CASHIER', name: 'Компания "Тозон" (Илхомчон)', id: '6ddf2f64-0a77-4aeb-8daf-a391b2da0141' },
  { key: 'SALES_MANAGER_Dadojon', name: 'Касса менеджера (Дадочон)', id: 'fba621e6-4ebe-4459-8623-19f46d864cc6' },
  { key: 'BANK_ACCOUNT', name: 'Расчётный счёт в банке', id: 'c16e402e-2af2-4f12-9e9a-073d72a9682a' },
];

async function calculateIndependentControlSum(deskId = null, year = 2026) {
  const db = getDB();
  const { data: rawExpenses, error } = await db.from('expenses').select(`
    id, amount_minor, currency, expense_date, category, method, reference, recipient, description,
    exchange_rate, amount_usd, status, cash_desk_id
  `).order('expense_date', { ascending: false });

  if (error) throw error;

  const eskhataRate = 9.27;
  const filtered = (rawExpenses || []).filter(e => {
    if (e.status === 'VOIDED') return false;
    const y = e.expense_date ? new Date(e.expense_date).getFullYear() : null;
    if (y !== year) return false;
    if (deskId && e.cash_desk_id !== deskId) return false;

    // Filter out internal conversion entries (КОНВ-*)
    const isInternalConversion = e.category === 'Конвертация валюты' || 
      (e.recipient && e.recipient.includes('Касса') && e.recipient.includes('Автоконвертация')) ||
      (e.reference && e.reference.startsWith('КОНВ-'));
    return !isInternalConversion;
  });

  let sumUsd = 0;
  filtered.forEach(e => {
    const cur = (e.currency || 'USD').toUpperCase();
    const amount = (e.amount_minor || 0) / 100;
    let usdVal = 0;
    if (cur === 'USD') {
      usdVal = amount;
    } else if (e.amount_usd && Number(e.amount_usd) > 0) {
      usdVal = Number(e.amount_usd);
    } else if (e.exchange_rate && Number(e.exchange_rate) > 0) {
      usdVal = Number((amount / Number(e.exchange_rate)).toFixed(2));
    } else {
      usdVal = Number((amount / eskhataRate).toFixed(2));
    }
    sumUsd += usdVal;
  });

  return Number(sumUsd.toFixed(2));
}

async function runAutomatedUsdConsistencyTest() {
  console.log('===================================================================================');
  console.log('=== AUTOMATED TEST: EXPENSES THREE-WAY USD CONSISTENCY (Card vs Chart vs Control) ===');
  console.log('===================================================================================');

  for (const desk of DESKS) {
    const filter = { year: 2026 };
    if (desk.id) filter.cash_desk_id = desk.id;

    // 1. Get repository response (Card & Chart)
    const res = await FinanceRepository.getExpenses(filter, { isAdmin: true });
    const cardUsd = Number((res.totalsByCurrency?.USD || 0).toFixed(2));
    const chartUsdSum = Number((res.categoriesChart || []).reduce((sum, cat) => sum + (cat.amount || 0), 0).toFixed(2));

    // 2. Get independent control sum directly from source DB documents
    const independentControlSum = await calculateIndependentControlSum(desk.id, 2026);

    const diffCardChart = Math.abs(cardUsd - chartUsdSum);
    const diffCardControl = Math.abs(cardUsd - independentControlSum);

    console.log(`[TEST] Desk: "${desk.name}"`);
    console.log(`       Card USD:        $${cardUsd.toFixed(2)}`);
    console.log(`       Chart USD Sum:   $${chartUsdSum.toFixed(2)}`);
    console.log(`       Independent DB:  $${independentControlSum.toFixed(2)}`);
    console.log(`       Diff Card-Chart: ${diffCardChart.toFixed(4)}`);
    console.log(`       Diff Card-DB:    ${diffCardControl.toFixed(4)}`);

    assert.ok(diffCardChart <= 0.01, `Card vs Chart mismatch for ${desk.name}`);
    assert.ok(diffCardControl <= 0.01, `Card vs Independent DB mismatch for ${desk.name}`);
    console.log(`       STATUS: PASSED (100% Three-Way Match within $0.01)\n`);
  }

  console.log('ALL CASH DESK TESTS PASSED SUCCESSFULLY! 100% THREE-WAY CONSISTENCY VERIFIED.');
  process.exit(0);
}

runAutomatedUsdConsistencyTest().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
