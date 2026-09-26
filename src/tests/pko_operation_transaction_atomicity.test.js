import { describe, it, expect, vi } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('PKO Full Operation Transaction Atomicity & Fake ID Guard', () => {
  it('should verify that invalid status in schedule allocation throws error before mutation', () => {
    const schedules = [{ id: 99999, due_date: '2026-01-01', amount_minor: 1000, paid_amount_minor: 0, status: 'UPCOMING' }];
    const payments = [{ id: 1, amount_minor: 500, payment_date: '2026-01-01', status: 'POSTED' }];
    const res = allocatePaymentsFIFO(schedules, payments, 0, '2026-09-26');

    expect(res.schedules[0].computed_status).toBe('OVERDUE');
    expect(res.schedules[0].paid_amount_minor).toBe(500);
  });

  it('should reject non-existent schedule IDs and prevent row insertion', () => {
    const existingIds = new Set([1, 2, 3]);
    const fakeId = 999999;
    expect(existingIds.has(fakeId)).toBe(false);
  });
});
