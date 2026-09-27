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
  assert.strictEqual(rko2026USD.operationalExpenses.USD, 228148.74, 'Operational USD expenses must be $228,148.74 USD');
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

  // Test Case 6: Partner Investment Unified Category Assertion
  console.log('[TEST 6] Unified Partner Investment Category...');
  const partnerCat = pko2026USD.categoriesChart.find(c => c.name === 'Инвестиции партнёров');
  assert.ok(partnerCat, 'Category "Инвестиции партнёров" must exist in chart');
  assert.strictEqual(partnerCat.amount, 36237.92, 'Unified Partner Investment amount must equal $36,237.92 USD');
  console.log('  ✅ TEST 6 PASSED: Category "Инвестиции партнёров" is unified and equals $36,237.92 USD.');

  // Test Case 7: Search and Filter Consistency
  console.log('[TEST 7] Search & Filter Consistency...');
  const searchRes = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', search: 'Мубинчон' });
  const searchChartSum = searchRes.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  const searchListSum = searchRes.list.reduce((acc, p) => acc + p.amount, 0);
  assert.strictEqual(Number(searchChartSum.toFixed(2)), Number(searchListSum.toFixed(2)), 'Diagram sum must match list sum for search results');
  console.log('  ✅ TEST 7 PASSED: Chart sum matches list sum perfectly under search filter.');

  // Test Case 8: Empty Selection Edge Case
  console.log('[TEST 8] Empty Selection Edge Case...');
  const emptyRes = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', search: 'NON_EXISTENT_QUERY_XYZ_123' });
  assert.strictEqual(emptyRes.list.length, 0, 'List must be empty');
  assert.strictEqual(emptyRes.categoriesChart.length, 0, 'Categories chart must be empty');
  console.log('  ✅ TEST 8 PASSED: Empty selection returns 0 items and empty chart.');

  console.log('\n=====================================================');
  console.log('       ALL ASSERTION RECONCILIATION TESTS PASSED     ');
  console.log('=====================================================');
}

runStrictReconciliationTests().catch(err => {
  console.error('\n❌ RECONCILIATION TEST FAILURE:', err);
  process.exit(1);
});
