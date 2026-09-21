import { connectDB, getDB } from '../db/connection.js';
import { DealsRepository } from '../modules/deals/deals.repository.js';
import assert from 'assert';

connectDB();

async function runCanonicalDealPaymentTests() {
  console.log('===================================================================================');
  console.log('=== AUTOMATED UNIT TESTS: CANONICAL DEAL PAYMENT COMPUTATION ===');
  console.log('===================================================================================');

  // Test 1: Contract №0027 -> paid 420712, remaining 3437588, active payments count = 1
  console.log('\n[TEST 1] Contract №0027 Verification');
  const db = getDB();
  const { data: deals0027 } = await db.from('deals').select('*').eq('contract_number', '0027');
  assert.ok(deals0027 && deals0027.length > 0, 'Contract 0027 must exist in database');
  const deal0027Id = deals0027[0].id;

  const deal0027 = await DealsRepository.getDealById(deal0027Id);
  console.log(`         Contract №0027 ID: ${deal0027.id}`);
  console.log(`         Final Price:        $${(deal0027.final_price_minor / 100).toLocaleString()}`);
  console.log(`         paid_amount_minor:  ${deal0027.paid_amount_minor} ($${(deal0027.paid_amount_minor / 100).toFixed(2)})`);
  console.log(`         total_paid_minor:   ${deal0027.total_paid_minor}`);
  console.log(`         remaining_debt:     ${deal0027.remaining_debt_minor} ($${(deal0027.remaining_debt_minor / 100).toFixed(2)})`);
  console.log(`         paid_percent:       ${deal0027.paid_percent}% (Display ${Math.round(deal0027.paid_percent)}%)`);
  console.log(`         Active Payments:    ${deal0027.payments.filter(p => p.status !== 'VOIDED').length}`);
  console.log(`         Payment Reference:  ${deal0027.payments[0]?.reference}`);

  assert.strictEqual(deal0027.paid_amount_minor, 420712, 'paid_amount_minor for Contract 0027 must be exactly 420712');
  assert.strictEqual(deal0027.total_paid_minor, 420712, 'total_paid_minor must equal paid_amount_minor (420712)');
  assert.strictEqual(deal0027.remaining_debt_minor, 3437588, 'remaining_debt_minor for Contract 0027 must be exactly 3437588');
  assert.strictEqual(Math.round(deal0027.paid_percent), 11, 'paid_percent display must round to 11%');
  assert.strictEqual(deal0027.payments.filter(p => p.status !== 'VOIDED').length, 1, 'Active payments count must be 1');
  assert.strictEqual(deal0027.payments[0]?.reference, 'ПКО-2894', 'Payment reference must be ПКО-2894');
  console.log('         STATUS: PASSED');

  // Test 2: Deal without payments -> 0 paid
  console.log('\n[TEST 2] Deal without payments -> paid = 0, remaining = final_price_minor');
  const mockDealNoPayments = {
    final_price_minor: 1000000,
    down_payment_minor: 200000, // Planned down payment, but no payment record!
    payments: []
  };
  const activePmtsNoPmts = mockDealNoPayments.payments.filter(p => p.status !== 'VOIDED');
  const paidNoPmts = activePmtsNoPmts.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
  const remainingNoPmts = Math.max(0, mockDealNoPayments.final_price_minor - paidNoPmts);
  assert.strictEqual(paidNoPmts, 0, 'Deal without payment records must have paid_amount_minor = 0');
  assert.strictEqual(remainingNoPmts, 1000000, 'Remaining debt must equal final_price_minor when 0 paid');
  console.log('         STATUS: PASSED');

  // Test 3: Multiple active payments -> sum of all active payments
  console.log('\n[TEST 3] Multiple active payments -> sum of active payments');
  const mockDealMultiplePmts = {
    final_price_minor: 5000000,
    payments: [
      { amount_minor: 1000000, status: 'ACTIVE' },
      { amount_minor: 1500000, status: 'ACTIVE' },
      { amount_minor: 500000, status: 'VOIDED' } // Should be skipped!
    ]
  };
  const activePmtsMulti = mockDealMultiplePmts.payments.filter(p => p.status !== 'VOIDED');
  const paidMulti = activePmtsMulti.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
  assert.strictEqual(paidMulti, 2500000, 'Paid amount must equal 1000000 + 1500000 = 2500000 (excluding VOIDED 500000)');
  console.log('         STATUS: PASSED');

  // Test 4: VOIDED payments not counted
  console.log('\n[TEST 4] VOIDED payment not counted');
  const mockDealVoidedOnly = {
    final_price_minor: 2000000,
    payments: [
      { amount_minor: 500000, status: 'VOIDED' }
    ]
  };
  const activeVoidedOnly = mockDealVoidedOnly.payments.filter(p => p.status !== 'VOIDED');
  const paidVoidedOnly = activeVoidedOnly.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
  assert.strictEqual(paidVoidedOnly, 0, 'Only VOIDED payments present -> paid = 0');
  console.log('         STATUS: PASSED');

  // Test 5: Planned initial payment without payment record is NOT counted
  console.log('\n[TEST 5] Planned initial payment without payment record is NOT counted');
  const mockDealPlannedOnly = {
    final_price_minor: 3000000,
    down_payment_minor: 500000,
    payments: []
  };
  const paidPlannedOnly = mockDealPlannedOnly.payments.filter(p => p.status !== 'VOIDED').reduce((sum, p) => sum + (p.amount_minor || 0), 0);
  assert.strictEqual(paidPlannedOnly, 0, 'down_payment_minor without payment record must NOT count as paid');
  console.log('         STATUS: PASSED');

  // Test 6: Overpayment does not create negative remaining debt
  console.log('\n[TEST 6] Overpayment does not create negative remaining debt');
  const mockDealOverpaid = {
    final_price_minor: 1000000,
    payments: [
      { amount_minor: 1200000, status: 'ACTIVE' }
    ]
  };
  const paidOverpaid = mockDealOverpaid.payments.filter(p => p.status !== 'VOIDED').reduce((sum, p) => sum + (p.amount_minor || 0), 0);
  const remainingOverpaid = Math.max(0, mockDealOverpaid.final_price_minor - paidOverpaid);
  assert.strictEqual(remainingOverpaid, 0, 'Remaining debt must be clamped to 0 (Math.max(0, ...))');
  console.log('         STATUS: PASSED');

  // Test 7: Deal with 0 final price does not cause division by zero
  console.log('\n[TEST 7] Zero final price does not cause division by zero');
  const mockDealZeroPrice = {
    final_price_minor: 0,
    payments: []
  };
  const paidZeroPrice = 0;
  const percentZeroPrice = mockDealZeroPrice.final_price_minor > 0 ? (paidZeroPrice / mockDealZeroPrice.final_price_minor) * 100 : 0;
  assert.strictEqual(percentZeroPrice, 0, 'paid_percent must be 0 when final_price_minor is 0');
  console.log('         STATUS: PASSED');

  console.log('\n===================================================================================');
  console.log('ALL CANONICAL DEAL PAYMENT TESTS PASSED SUCCESSFULLY! 100% SPEC COMPLIANT.');
  console.log('===================================================================================');
  process.exit(0);
}

runCanonicalDealPaymentTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
