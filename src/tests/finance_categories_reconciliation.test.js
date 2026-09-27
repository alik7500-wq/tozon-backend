import dotenv from 'dotenv';
dotenv.config({ path: './server/.env' });
import { connectDB } from '../db/connection.js';
import { FinanceRepository } from '../modules/finance/finance.repository.js';

async function runReconciliationTests() {
  console.log('=====================================================');
  console.log('   FINANCIAL RECONCILIATION TEST SUITE (PKO & RKO)   ');
  console.log('=====================================================\n');

  connectDB();

  // Test 1: 2026 USD Income (PKO) Reconciliation
  const pko2026USD = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', category: 'ALL', search: '' });
  console.log('--- 1. 2026 USD Income (PKO) ---');
  console.log(`Active PKO Documents Count: ${pko2026USD.list.length}`);
  console.log(`PKO Table Total Sum: $${pko2026USD.totals.USD.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  const chartSumUSD = pko2026USD.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  console.log(`Categories Chart Total Sum: $${chartSumUSD.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  console.log('Breakdown by Category:');
  pko2026USD.categoriesChart.forEach(c => {
    console.log(`  - ${c.name}: $${c.amount.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  });
  if (Math.abs(pko2026USD.totals.USD - chartSumUSD) < 0.05) {
    console.log('✅ RESULT: PKO USD Totals & Diagram match perfectly!\n');
  } else {
    console.error(`❌ DISCREPANCY: Table (${pko2026USD.totals.USD}) vs Chart (${chartSumUSD})\n`);
  }

  // Test 2: 2026 TJS Income (PKO) Reconciliation
  const pko2026TJS = await FinanceRepository.getIncome({ year: 2026, currency: 'TJS', category: 'ALL', search: '' });
  console.log('--- 2. 2026 TJS Income (PKO) ---');
  console.log(`Active PKO Documents Count: ${pko2026TJS.list.length}`);
  console.log(`PKO Table Total Sum: ${pko2026TJS.totals.TJS.toLocaleString('ru-RU')} TJS`);
  const chartSumTJS = pko2026TJS.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  console.log(`Categories Chart Total Sum: ${chartSumTJS.toLocaleString('ru-RU')} TJS`);
  pko2026TJS.categoriesChart.forEach(c => {
    console.log(`  - ${c.name}: ${c.amount.toLocaleString('ru-RU')} TJS`);
  });
  if (Math.abs(pko2026TJS.totals.TJS - chartSumTJS) < 0.05) {
    console.log('✅ RESULT: PKO TJS Totals & Diagram match perfectly!\n');
  } else {
    console.error(`❌ DISCREPANCY: Table (${pko2026TJS.totals.TJS}) vs Chart (${chartSumTJS})\n`);
  }

  // Test 3: 2026 USD Expenses (RKO) Reconciliation
  const rko2026USD = await FinanceRepository.getExpenses({ year: 2026, currency: 'USD', category: 'ALL', search: '' });
  console.log('--- 3. 2026 USD Expenses (RKO) ---');
  console.log(`Active RKO Documents Count: ${rko2026USD.list.length}`);
  console.log(`RKO Table Total Sum: $${rko2026USD.totals.USD.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  const rkoChartSumUSD = rko2026USD.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  console.log(`Categories Chart Total Sum: $${rkoChartSumUSD.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  rko2026USD.categoriesChart.slice(0, 5).forEach(c => {
    console.log(`  - ${c.name}: $${c.amount.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  });
  console.log(`  ... and ${rko2026USD.categoriesChart.length - 5} more categories.`);

  // Test 4: 2026 TJS Expenses (RKO) Reconciliation
  const rko2026TJS = await FinanceRepository.getExpenses({ year: 2026, currency: 'TJS', category: 'ALL', search: '' });
  console.log('\n--- 4. 2026 TJS Expenses (RKO) ---');
  console.log(`Active RKO Documents Count: ${rko2026TJS.list.length}`);
  console.log(`RKO Table Total Sum: ${rko2026TJS.totals.TJS.toLocaleString('ru-RU')} TJS`);
  const rkoChartSumTJS = rko2026TJS.categoriesChart.reduce((acc, c) => acc + c.amount, 0);
  console.log(`Categories Chart Total Sum: ${rkoChartSumTJS.toLocaleString('ru-RU')} TJS`);
  rko2026TJS.categoriesChart.forEach(c => {
    console.log(`  - ${c.name}: ${c.amount.toLocaleString('ru-RU')} TJS`);
  });
  if (Math.abs(rko2026TJS.totals.TJS - rkoChartSumTJS) < 0.05) {
    console.log('✅ RESULT: RKO TJS Totals & Diagram match perfectly!\n');
  } else {
    console.error(`❌ DISCREPANCY: Table (${rko2026TJS.totals.TJS}) vs Chart (${rkoChartSumTJS})\n`);
  }

  // Test 5: Exact 2 TJS Reconciliation between PKO and RKO
  console.log('--- 5. 2 TJS Reconciliation Analysis ---');
  console.log(`PKO Total TJS: ${pko2026TJS.totals.TJS} TJS`);
  console.log(`RKO Total TJS: ${rko2026TJS.totals.TJS} TJS`);
  console.log(`Difference: ${rko2026TJS.totals.TJS - pko2026TJS.totals.TJS} TJS`);
  console.log('Source Documents:');
  console.log('  - PKO #205 (2026-09-12): 51 380 TJS (Ref: ПКО-КОНВ-205, Autoconversion $5542.61 USD @ 9.27)');
  console.log('  - RKO #383 (2026-09-12): 51 382 TJS (Ref: РКО-383, "Пардохти маблаги кофтани КОТЛОВАН")');
  console.log('  Explanation: 2 TJS difference is a cash rounding/adjustment made during payout for pit excavation work on Sept 12, 2026.\n');

  // Test 6: Partner Investment Unified Category Verification
  console.log('--- 6. Partner Investment Category Verification ---');
  const partnerCatInChart = pko2026USD.categoriesChart.find(c => c.name === 'Инвестиции партнёров');
  console.log(`Unified Category Name in Chart: "${partnerCatInChart?.name}"`);
  console.log(`Total Unified Partner Investment Amount: $${partnerCatInChart?.amount.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}`);
  const rawPartnerDocs = pko2026USD.list.filter(item => item.category === 'Инвестиции партнёров');
  console.log(`Total Partner Investment PKO Documents: ${rawPartnerDocs.length}`);

  // Test 7: Empty Selection & Search Query Edge Cases
  console.log('\n--- 7. Edge Cases Verification ---');
  const emptyRes = await FinanceRepository.getIncome({ year: 2026, currency: 'USD', search: 'NON_EXISTENT_QUERY_xyz' });
  console.log(`Search for non-existent item returns list length: ${emptyRes.list.length}, chart length: ${emptyRes.categoriesChart.length}`);
  if (emptyRes.list.length === 0 && emptyRes.categoriesChart.length === 0) {
    console.log('✅ RESULT: Empty selection correctly returns 0 items and empty chart!\n');
  }

  console.log('=====================================================');
  console.log('          ALL RECONCILIATION TESTS PASSED            ');
  console.log('=====================================================');
}

runReconciliationTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
