import dotenv from 'dotenv';
dotenv.config({ path: './server/.env' });
import assert from 'assert';
import { connectDB } from '../db/connection.js';
import { FinanceRepository } from '../modules/finance/finance.repository.js';

async function runStrictReconciliationTests() {
  console.log('=====================================================');
  console.log('  STRICT ASSERTION TEST SUITE: PKO & RKO RECONCILIATION');
  console.log('=====================================================\n');

  connectDB();

  // Test Case 1: 2026 USD Income (PKO)
  console.log('[TEST 1] 2026 USD Income (PKO) Reconciliation...');
  const pko2026USD = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', category: 'ALL', search: '' });
  assert.strictEqual(typeof pko2026USD.totals.USD, 'number', 'USD total must be a number');
  assert.strictEqual(pko2026USD.list.length, 106, 'Active USD PKO documents count in 2026 must be 106');
  assert.strictEqual(pko2026USD.totals.USD, 276882.14, 'Total USD PKO sum must be $276,882.14');
  
  const pkoChartSumUSD = pko2026USD.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  assert.strictEqual(Number(pkoChartSumUSD.toFixed(2)), 276882.14, 'PKO USD Categories Chart sum must equal table total $276,882.14');
  console.log('  ✅ TEST 1 PASSED: 106 docs, total $276,882.14 USD matches chart 100%.');

  // Test Case 2: 2026 TJS Income (PKO)
  console.log('[TEST 2] 2026 TJS Income (PKO) Reconciliation...');
  const pko2026TJS = await FinanceRepository.getIncome({ year: 2026, currency: 'TJS', category: 'ALL', search: '' });
  assert.strictEqual(pko2026TJS.list.length, 29, 'Active TJS PKO documents count in 2026 must be 29');
  assert.strictEqual(pko2026TJS.totals.TJS, 166465, 'Total TJS PKO sum must be 166,465 TJS');
  
  const pkoChartSumTJS = pko2026TJS.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  assert.strictEqual(pkoChartSumTJS, 166465, 'PKO TJS Categories Chart sum must equal table total 166,465 TJS');
  console.log('  ✅ TEST 2 PASSED: 29 docs, total 166,465 TJS matches chart 100%.');

  // Test Case 3: 2026 USD Expenses (RKO) & $17,955.66 Conversion Difference
  console.log('[TEST 3] 2026 USD Expenses (RKO) & Conversion Difference...');
  const rko2026USD = await FinanceRepository.getExpenses({ year: 2026, currency: 'USD', category: 'ALL', search: '' });
  assert.strictEqual(rko2026USD.list.length, 182, 'Active USD RKO documents count in 2026 must be 182');
  assert.strictEqual(rko2026USD.totals.USD, 246104.40, 'Total USD cash payout out of USD desk must be $246,104.40 USD');
  assert.strictEqual(rko2026USD.operationalExpenses.USD, 228148.74, 'Operational USD expenses (Выплаты без конвертаций) must be $228,148.74 USD');
  assert.strictEqual(rko2026USD.conversionDifferenceUsd, 17955.66, 'Conversion difference (autoconversions) must be exactly $17,955.66 USD');
  assert.strictEqual(
    Number((rko2026USD.operationalExpenses.USD + rko2026USD.conversionDifferenceUsd).toFixed(2)),
    rko2026USD.totals.USD,
    'Operational USD Expenses + Conversion Difference must equal Total USD Payout ($246,104.40 USD)'
  );

  const rkoChartSumUSD = rko2026USD.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  assert.strictEqual(Number(rkoChartSumUSD.toFixed(2)), 228148.74, 'Operational Categories Chart sum must equal $228,148.74 USD');
  console.log('  ✅ TEST 3 PASSED: Total payout $246,104.40 USD = Operational $228,148.74 USD + Conversions $17,955.66 USD.');

  // Test Case 4: 2026 TJS Expenses (RKO)
  console.log('[TEST 4] 2026 TJS Expenses (RKO) Reconciliation...');
  const rko2026TJS = await FinanceRepository.getExpenses({ year: 2026, currency: 'TJS', category: 'ALL', search: '' });
  assert.strictEqual(rko2026TJS.list.length, 29, 'Active TJS RKO documents count in 2026 must be 29');
  assert.strictEqual(rko2026TJS.totals.TJS, 166467, 'Total TJS RKO sum must be 166,467 TJS');
  
  const rkoChartSumTJS = rko2026TJS.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  assert.strictEqual(rkoChartSumTJS, 166467, 'RKO TJS Categories Chart sum must equal table total 166,467 TJS');
  console.log('  ✅ TEST 4 PASSED: 29 docs, total 166,467 TJS matches chart 100%.');

  // Test Case 5: 2 TJS Document Assertion (PKO #205 vs RKO #383)
  console.log('[TEST 5] 2 TJS Document Reconciliation Assertion...');
  const pko205 = pko2026TJS.list.find(p => p.id === 205);
  const rko383 = rko2026TJS.list.find(e => e.id === 383);
  assert.ok(pko205, 'PKO #205 must exist in TJS active payments');
  assert.ok(rko383, 'RKO #383 must exist in TJS active expenses');
  assert.strictEqual(pko205.amount, 51380, 'PKO #205 amount must be 51,380 TJS');
  assert.strictEqual(rko383.amount, 51382, 'RKO #383 amount must be 51,382 TJS');
  assert.strictEqual(rko383.amount - pko205.amount, 2, 'Difference between RKO #383 and PKO #205 must be exactly 2 TJS');
  console.log('  ✅ TEST 5 PASSED: Verified PKO #205 (51,380 TJS) vs RKO #383 (51,382 TJS) exact 2 TJS difference.');

  // Test Case 6: Category Filter Consistency in Chart and Journal
  console.log('[TEST 6] Category Filter Consistency in Chart & Journal...');
  const pkoCategoryFiltered = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', category: 'Инвестиции партнёров' });
  assert.strictEqual(pkoCategoryFiltered.categoriesChart.length, 1, 'Categories chart under specific category filter must contain exactly 1 entry');
  assert.strictEqual(pkoCategoryFiltered.categoriesChart[0].name, 'Инвестиции партнёров', 'Chart category name must match filter');
  const pkoFilteredSum = pkoCategoryFiltered.list.reduce((acc, p) => acc + p.amount, 0);
  assert.strictEqual(pkoCategoryFiltered.categoriesChart[0].amount, Number(pkoFilteredSum.toFixed(2)), 'Chart amount must equal filtered list sum');

  const rkoCategoryFiltered = await FinanceRepository.getExpenses({ year: 2026, currency: 'TJS', category: 'Услуги подрядчиков и специалистов' });
  assert.strictEqual(rkoCategoryFiltered.categoriesChart.length, 1, 'Categories chart under specific RKO category filter must contain exactly 1 entry');
  assert.strictEqual(rkoCategoryFiltered.categoriesChart[0].name, 'Услуги подрядчиков и специалистов', 'Chart category name must match filter');
  const rkoFilteredSum = rkoCategoryFiltered.list.reduce((acc, e) => acc + e.amount, 0);
  assert.strictEqual(rkoCategoryFiltered.categoriesChart[0].amount, Number(rkoFilteredSum.toFixed(2)), 'Chart amount must equal filtered list sum');
  console.log('  ✅ TEST 6 PASSED: Category filter applies consistently to both chart and journal list.');

  // Test Case 7: Partner Investment Breakdown Separation
  console.log('[TEST 7] Partner Investments vs Buyer Deal Payments...');
  const pkoPartner = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', category: 'Инвестиции партнёров' });
  const pkoDeals = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', category: 'Оплата по договорам' });
  assert.strictEqual(pkoPartner.list.length, 23, 'Partner investment USD PKO docs count in 2026 must be 23');
  assert.strictEqual(pkoPartner.categoriesChart[0].amount, 36237.92, 'Partner investment USD total must be $36,237.92 USD');
  assert.strictEqual(pkoDeals.categoriesChart[0].amount, 229437.97, 'Buyer deals payment USD total must be $229,437.97 USD');
  console.log('  ✅ TEST 7 PASSED: Partner investments ($36,237.92 across 23 docs) are strictly separated from buyer deal payments ($229,437.97).');

  // Test Case 8: Search Filter Consistency
  console.log('[TEST 8] Search Filter Consistency...');
  const searchRes = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', search: 'Мубинчон' });
  const searchChartSum = searchRes.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  const searchListSum = searchRes.list.reduce((acc, p) => acc + p.amount, 0);
  assert.strictEqual(Number(searchChartSum.toFixed(2)), Number(searchListSum.toFixed(2)), 'Diagram sum must match list sum for search results');
  console.log('  ✅ TEST 8 PASSED: Chart sum matches list sum perfectly under search filter.');

  // Test Case 9: Fallback Rate 9.27 Audit Assertion
  console.log('[TEST 9] Fallback Exchange Rate 9.27 Audit...');
  const db = connectDB();
  const { data: payments } = await db.from('payments').select('*').is('voided_at', null);
  const fallbackPkoDocs = payments.filter(p => (p.currency || 'USD').toUpperCase() !== 'USD' && !p.exchange_rate && !p.amount_usd);
  assert.strictEqual(fallbackPkoDocs.length, 29, 'Exact count of TJS PKO documents using fallback rate 9.27 must be 29');
  console.log('  ✅ TEST 9 PASSED: Verified 29 TJS PKO autoconversion entries using fallback exchange rate 9.27.');

  // Test Case 10: Empty Selection Edge Case
  console.log('[TEST 10] Empty Selection Edge Case...');
  const emptyRes = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', search: 'NON_EXISTENT_QUERY_XYZ_123' });
  assert.strictEqual(emptyRes.list.length, 0, 'List must be empty');
  assert.strictEqual(emptyRes.categoriesChart.length, 0, 'Categories chart must be empty');
  console.log('  ✅ TEST 10 PASSED: Empty selection returns 0 items and empty chart.');

  console.log('\n=====================================================');
  console.log('       ALL ASSERTION RECONCILIATION TESTS PASSED     ');
  console.log('=====================================================');
}

runStrictReconciliationTests().catch(err => {
  console.error('\n❌ RECONCILIATION TEST FAILURE:', err);
  process.exit(1);
});
