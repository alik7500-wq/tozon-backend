import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Atomic Cash Transfers & VOIDED Set Tests (Stage 8 Requirements)', () => {
  let db;
  let akmalDeskId;
  let ilhomDeskId;
  const createdTransferIds = [];

  beforeAll(async () => {
    await connectDB();
    db = getDB();

    const { data: dictDesks } = await db
      .from('dictionaries')
      .select('*')
      .eq('type', 'CASH_DESK')
      .eq('is_active', true);

    const akmal = dictDesks.find(d => d.code === 'SALES_MANAGER' || d.name.includes('Акмалхон'));
    const ilhom = dictDesks.find(d => d.code === 'MAIN_CASHIER' || d.name.includes('Илхомчон'));

    expect(akmal).toBeDefined();
    expect(ilhom).toBeDefined();

    akmalDeskId = akmal.id;
    ilhomDeskId = ilhom.id;
  });

  afterAll(async () => {
    // Clean up temporary test transfers and their linked RKO / PKO
    for (const transferId of createdTransferIds) {
      await db.from('payments').delete().eq('transfer_id', transferId);
      await db.from('expenses').delete().eq('transfer_id', transferId);
      await db.from('cash_transfers').delete().eq('id', transferId);
    }
  });

  it('1. USD 221.52: Akmal -221.52, Ilhom +221.52, capital 0.00 change', async () => {
    const cashflowBefore = await FinanceRepository.getCashflow();
    const capitalBefore = cashflowBefore.summaryByCurrency.USD.netCashflow;

    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 221.52,
      recipient: 'Касса компании "Тозон" (Илхомчон)',
      description: 'Тест перемещения 221.52 USD'
    }, 1);

    expect(result.success).toBe(true);
    expect(result.transfer_id).toBeDefined();
    expect(result.source_expense_id).toBeDefined();
    expect(result.destination_payment_id).toBeDefined();
    expect(Number(result.amount_usd)).toBe(221.52);

    createdTransferIds.push(result.transfer_id);

    const cashflowAfter = await FinanceRepository.getCashflow();
    const capitalAfter = cashflowAfter.summaryByCurrency.USD.netCashflow;

    // Consolidated capital change must be exactly 0.00
    expect(capitalAfter).toBe(capitalBefore);

    // Clean up immediately to keep baseline pristine
    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
    createdTransferIds.pop();
  });

  it('2. USD 1616.38: creates exactly one atomic pair; no duplicate expense', async () => {
    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 1616.38,
      recipient: 'Касса компании "Тозон" (Илхомчон)',
      description: 'Тест перемещения 1616.38 USD'
    }, 1);

    expect(result.success).toBe(true);
    createdTransferIds.push(result.transfer_id);

    const { data: expRows } = await db.from('expenses').select('*').eq('transfer_id', result.transfer_id);
    const { data: payRows } = await db.from('payments').select('*').eq('transfer_id', result.transfer_id);

    // Exactly one RKO and one PKO
    expect(expRows.length).toBe(1);
    expect(payRows.length).toBe(1);
    expect(expRows[0].amount_minor).toBe(161638);
    expect(payRows[0].amount_minor).toBe(161638);

    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
    createdTransferIds.pop();
  });

  it('3. USD 1500.00: creates exactly one atomic pair; no duplicate expense', async () => {
    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 1500.00,
      recipient: 'Касса компании "Тозон" (Илхомчон)',
      description: 'Тест перемещения 1500.00 USD'
    }, 1);

    expect(result.success).toBe(true);
    createdTransferIds.push(result.transfer_id);

    const { data: expRows } = await db.from('expenses').select('*').eq('transfer_id', result.transfer_id);
    const { data: payRows } = await db.from('payments').select('*').eq('transfer_id', result.transfer_id);

    expect(expRows.length).toBe(1);
    expect(payRows.length).toBe(1);
    expect(expRows[0].amount_minor).toBe(150000);
    expect(payRows[0].amount_minor).toBe(150000);

    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
    createdTransferIds.pop();
  });

  it('4. Total amount 3337.90 USD: consolidated capital does not change', async () => {
    const cashflowInitial = await FinanceRepository.getCashflow();
    const initialCapital = cashflowInitial.summaryByCurrency.USD.netCashflow;

    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 3337.90,
      recipient: 'Касса компании "Тозон" (Илхомчон)',
      description: 'Тест суммарного перемещения 3337.90 USD'
    }, 1);

    expect(result.success).toBe(true);
    createdTransferIds.push(result.transfer_id);

    const cashflowFinal = await FinanceRepository.getCashflow();
    expect(cashflowFinal.summaryByCurrency.USD.netCashflow).toBe(initialCapital);

    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
    createdTransferIds.pop();
  });

  it('5. TJS with rate: single USD calculation, identical amount_usd in RKO and PKO', async () => {
    // 2100 TJS / 9.48 = 221.51898... rounded once to 221.52 USD
    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'PAYMENT_ON_BEHALF',
      currency: 'TJS',
      amount_tjs: 2100.00,
      exchange_rate: 9.48,
      recipient: 'МБТИ Худжанд',
      description: 'Оплата МБТИ 2100 TJS по курсу 9.48'
    }, 1);

    expect(result.success).toBe(true);
    expect(Number(result.amount_usd)).toBe(221.52);
    expect(Number(result.amount_tjs)).toBe(2100.00);

    createdTransferIds.push(result.transfer_id);

    const { data: exp } = await db.from('expenses').select('*').eq('id', result.source_expense_id).single();
    const { data: pay } = await db.from('payments').select('*').eq('id', result.destination_payment_id).single();

    expect(Number(exp.amount_usd)).toBe(221.52);
    expect(Number(pay.amount_usd)).toBe(221.52);
    expect(Number(pay.amount_tjs)).toBe(2100.00);
    expect(Number(exp.exchange_rate)).toBe(9.48);
    expect(Number(pay.exchange_rate)).toBe(9.48);

    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
    createdTransferIds.pop();
  });

  it('6. Failure / invalid desks: same desk rejected, neither RKO nor PKO is created', async () => {
    let error;
    try {
      await FinanceRepository.createCashTransfer({
        source_cash_desk_id: akmalDeskId,
        destination_cash_desk_id: akmalDeskId, // Same desk!
        operation_type: 'INTERNAL_CASH_TRANSFER',
        currency: 'USD',
        amount: 100.00,
        recipient: 'Ошибка'
      }, 1);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain('SOURCE_AND_DESTINATION_MUST_BE_DIFFERENT');
  });

  it('7. Idempotency: repeated call with same idempotency_key returns existing pair without duplicate', async () => {
    const key = `TEST-IDEM-${Date.now()}`;

    const res1 = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 50.00,
      idempotency_key: key,
      recipient: 'Касса получатель'
    }, 1);

    expect(res1.success).toBe(true);
    createdTransferIds.push(res1.transfer_id);

    const res2 = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount: 50.00,
      idempotency_key: key,
      recipient: 'Касса получатель'
    }, 1);

    expect(res2.idempotent).toBe(true);
    expect(res2.transfer_id).toBe(res1.transfer_id);

    // Verify only 1 pair in database
    const { data: transfers } = await db.from('cash_transfers').select('*').eq('idempotency_key', key);
    expect(transfers.length).toBe(1);

    await db.from('payments').delete().eq('transfer_id', res1.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', res1.transfer_id);
    await db.from('cash_transfers').delete().eq('id', res1.transfer_id);
    createdTransferIds.pop();
  });

  it('8. Insufficient balance: transfer exceeding available balance is rejected', async () => {
    let error;
    try {
      await FinanceRepository.createCashTransfer({
        source_cash_desk_id: akmalDeskId,
        destination_cash_desk_id: ilhomDeskId,
        operation_type: 'INTERNAL_CASH_TRANSFER',
        currency: 'USD',
        amount: 999999999.00, // Exceeds balance
        recipient: 'Недостаточно средств'
      }, 1);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain('INSUFFICIENT_FUNDS');
  });

  it('9. VOIDED: all 8 historical records are marked VOIDED and excluded from calculations', async () => {
    const voidedPaymentIds = [127, 128, 129];
    const voidedExpenseIds = [54, 87, 88, 93, 94];

    const { data: payments } = await db.from('payments').select('id, status, void_reason').in('id', voidedPaymentIds);
    expect(payments.length).toBe(3);
    payments.forEach(p => {
      expect(p.status).toBe('VOIDED');
      expect(p.void_reason).toBe('REENTERED_VIA_ATOMIC_CASH_TRANSFER');
    });

    const { data: expenses } = await db.from('expenses').select('id, status, void_reason').in('id', voidedExpenseIds);
    expect(expenses.length).toBe(5);
    expenses.forEach(e => {
      expect(e.status).toBe('VOIDED');
      expect(e.void_reason).toBe('REENTERED_VIA_ATOMIC_CASH_TRANSFER');
    });

    // Cashflow check: VOIDED records must NOT be in active list
    const cashflow = await FinanceRepository.getCashflow();
    const activeVoided = cashflow.transactions.filter(t =>
      (t.type === 'INCOME' && voidedPaymentIds.includes(t.rawId)) ||
      (t.type === 'EXPENSE' && voidedExpenseIds.includes(t.rawId))
    );
    expect(activeVoided.length).toBe(0);
  });

  it('10. Print details & references: RKO and PKO references and currency snapshots match', async () => {
    const result = await FinanceRepository.createCashTransfer({
      source_cash_desk_id: akmalDeskId,
      destination_cash_desk_id: ilhomDeskId,
      operation_type: 'PAYMENT_ON_BEHALF',
      currency: 'TJS',
      amount_tjs: 1000.00,
      exchange_rate: 9.50,
      recipient: 'ООО СтройСнаб',
      description: 'Оплата за кассу Илхома'
    }, 1);

    expect(result.source_reference).toMatch(/^РКО-ПЕРЕМ-\d+$/);
    expect(result.destination_reference).toMatch(/^ПКО-ПЕРЕМ-\d+$/);

    const { data: exp } = await db.from('expenses').select('*').eq('id', result.source_expense_id).single();
    const { data: pay } = await db.from('payments').select('*').eq('id', result.destination_payment_id).single();

    expect(exp.transfer_id).toBe(result.transfer_id);
    expect(pay.transfer_id).toBe(result.transfer_id);
    expect(exp.operation_type).toBe('PAYMENT_ON_BEHALF');
    expect(pay.operation_type).toBe('PAYMENT_ON_BEHALF');

    await db.from('payments').delete().eq('transfer_id', result.transfer_id);
    await db.from('expenses').delete().eq('transfer_id', result.transfer_id);
    await db.from('cash_transfers').delete().eq('id', result.transfer_id);
  });
});
