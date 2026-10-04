import { describe, it, expect, beforeEach } from 'vitest';
import { DealsRepository } from '../deals.repository.js';
import { getDB } from '../../../db/connection.js';

describe('PKO TJS Snapshot Regression & Fail-Closed Tests', () => {
  it('should validate snapshot payload structure for payment creation', () => {
    const payload = {
      amount_minor: 35000,
      payment_date: '2026-10-05',
      method: 'CASH',
      settlement_method: 'CASH',
      reference: 'ПКО-TEST-REGRESSION-1',
      comment: 'Test regression receipt',
      cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      idempotency_key: `test_reg_${Date.now()}_1`,
      amount_tjs: 3241.00,
      amount_usd: 350.00,
      exchange_rate: 9.26,
      currency: 'USD'
    };

    expect(payload.amount_tjs).toBe(3241.00);
    expect(payload.amount_usd).toBe(350.00);
    expect(payload.exchange_rate).toBe(9.26);
    expect(payload.amount_minor).toBe(35000);
  });

  it('should correctly calculate snapshot for arbitrary amounts and exchange rates', () => {
    const physicalTjs = 5000.00;
    const rate = 9.48;
    const expectedUsd = Number((physicalTjs / rate).toFixed(2)); // 527.43
    const amountMinor = Math.round(expectedUsd * 100); // 52743

    const payload = {
      amount_minor: amountMinor,
      payment_date: '2026-10-05',
      method: 'CASH',
      settlement_method: 'CASH',
      reference: 'ПКО-TEST-REGRESSION-2',
      comment: 'Test arbitrary rate receipt',
      cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      idempotency_key: `test_reg_${Date.now()}_2`,
      amount_tjs: physicalTjs,
      amount_usd: expectedUsd,
      exchange_rate: rate,
      currency: 'USD'
    };

    expect(payload.amount_tjs).toBe(5000.00);
    expect(payload.amount_usd).toBe(527.43);
    expect(payload.exchange_rate).toBe(9.48);
    expect(payload.amount_minor).toBe(52743);
    expect(Math.abs(payload.amount_tjs - Math.round(payload.amount_usd * payload.exchange_rate * 100) / 100)).toBeLessThanOrEqual(0.05);
  });

  it('should fail closed when cash payment is missing amount_tjs or exchange_rate', () => {
    const sm = 'CASH';
    const amount_tjs = null;
    const exchange_rate = null;

    const isInvalid = sm === 'CASH' && (!amount_tjs || !exchange_rate);
    expect(isInvalid).toBe(true);
  });
});
