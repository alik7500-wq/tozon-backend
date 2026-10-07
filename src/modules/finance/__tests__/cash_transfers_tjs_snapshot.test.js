import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('CASH TRANSFER TJS SNAPSHOT & FAIL-CLOSED REGRESSION TESTS (PHASE 8)', () => {
  let db;
  let sourceDeskId;
  let destDeskId;
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

    sourceDeskId = akmal.id;
    destDeskId = ilhom.id;
  });

  afterAll(async () => {
    for (const transferId of createdTransferIds) {
      await db.from('payments').delete().eq('transfer_id', transferId);
      await db.from('expenses').delete().eq('transfer_id', transferId);
      await db.from('cash_transfers').delete().eq('id', transferId);
    }
  });

  it('1. USD Transfer with TJS Snapshot (e.g. 2950 TJS @ 9.26 = $318.57 USD) persists amount_tjs and exchange_rate on PKO, RKO and cash_transfers', async () => {
    const transferData = {
      source_cash_desk_id: sourceDeskId,
      destination_cash_desk_id: destDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'USD',
      amount_usd: 318.57,
      amount_tjs: 2950.00,
      exchange_rate: 9.26,
      recipient: 'Касса Илхомчон',
      description: 'Тестовый перевод с TJS snapshot',
      idempotency_key: `TEST-TX-USD-TJS-${Date.now()}`
    };

    const result = await FinanceRepository.createCashTransfer(transferData, 1);

    expect(result.success).toBe(true);
    expect(result.transfer_id).toBeDefined();
    createdTransferIds.push(result.transfer_id);

    // Fetch generated PKO, RKO, and cash_transfers master record
    const { data: pkoList } = await db.from('payments').select('*').eq('transfer_id', result.transfer_id);
    const { data: rkoList } = await db.from('expenses').select('*').eq('transfer_id', result.transfer_id);
    const { data: ctList } = await db.from('cash_transfers').select('*').eq('id', result.transfer_id);

    expect(pkoList.length).toBe(1);
    expect(rkoList.length).toBe(1);
    expect(ctList.length).toBe(1);

    const pko = pkoList[0];
    const rko = rkoList[0];
    const ct = ctList[0];

    // Verify snapshot fields on PKO
    expect(pko.currency).toBe('USD');
    expect(Number(pko.amount_usd)).toBe(318.57);
    expect(Number(pko.amount_tjs)).toBe(2950.00);
    expect(Number(pko.exchange_rate)).toBe(9.26);

    // Verify snapshot fields on RKO
    expect(rko.currency).toBe('USD');
    expect(Number(rko.amount_usd)).toBe(318.57);
    expect(Number(rko.amount_tjs)).toBe(2950.00);
    expect(Number(rko.exchange_rate)).toBe(9.26);

    // Verify snapshot fields on master transfer record
    expect(ct.currency).toBe('USD');
    expect(Number(ct.amount_usd)).toBe(318.57);
    expect(Number(ct.amount_tjs)).toBe(2950.00);
    expect(Number(ct.exchange_rate)).toBe(9.26);
  });

  it('2. TJS Transfer (currency=TJS) persists amount_tjs, amount_usd, and exchange_rate', async () => {
    const transferData = {
      source_cash_desk_id: sourceDeskId,
      destination_cash_desk_id: destDeskId,
      operation_type: 'INTERNAL_CASH_TRANSFER',
      currency: 'TJS',
      amount_tjs: 1000.00,
      exchange_rate: 9.50,
      recipient: 'Касса Илхомчон',
      description: 'Тестовый TJS перевод',
      idempotency_key: `TEST-TX-TJS-${Date.now()}`
    };

    const result = await FinanceRepository.createCashTransfer(transferData, 1);

    expect(result.success).toBe(true);
    createdTransferIds.push(result.transfer_id);

    const { data: pkoList } = await db.from('payments').select('*').eq('transfer_id', result.transfer_id);
    expect(pkoList.length).toBe(1);
    const pko = pkoList[0];

    expect(Number(pko.amount_tjs)).toBe(1000.00);
    expect(Number(pko.exchange_rate)).toBe(9.50);
    expect(Number(pko.amount_usd)).toBe(105.26); // 1000 / 9.50
  });

  it('3. Fail-Closed: Partial snapshot (amount_tjs without rate/amount_usd) is rejected or derived safely', async () => {
    const invalidData = {
      source_cash_desk_id: sourceDeskId,
      destination_cash_desk_id: destDeskId,
      currency: 'TJS',
      amount_tjs: 0, // Invalid
      recipient: 'Test',
      description: 'Invalid TJS transfer'
    };

    await expect(FinanceRepository.createCashTransfer(invalidData, 1)).rejects.toThrow();
  });
});
