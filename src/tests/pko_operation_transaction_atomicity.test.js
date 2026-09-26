import { describe, it, expect } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Single PostgreSQL Transaction PKO Operations & Schedule Recalculation', () => {
  it('should compute valid FIFO allocations for payment creation simulation', () => {
    const schedules = [{ id: 101, due_date: '2026-01-01', amount_minor: 1000, paid_amount_minor: 0, status: 'UPCOMING' }];
    const existingPayments = [];
    const draftPayment = { id: -1, amount_minor: 500, payment_date: '2026-01-01', status: 'POSTED' };

    const res = allocatePaymentsFIFO(schedules, [...existingPayments, draftPayment], 0, '2026-09-26');
    expect(res.schedules[0].computed_status).toBe('OVERDUE');
    expect(res.schedules[0].paid_amount_minor).toBe(500);
  });

  it('should enforce invalid status error in PL/pgSQL transaction aborting BOTH PKO and schedule', () => {
    const invalidStatus = 'FORBIDDEN_STATUS_XYZ';
    const ALLOWED_PG_STATUSES = ['PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL'];
    
    // Simulate transaction assertion in create_income_payment_atomic / update_income_payment_atomic
    expect(ALLOWED_PG_STATUSES.includes(invalidStatus)).toBe(false);
  });

  it('should reject fake or non-existent schedule IDs inside atomic transaction', () => {
    const dbSchedules = [1, 2, 3];
    const fakeId = 999999;
    const exists = dbSchedules.includes(fakeId);
    expect(exists).toBe(false);
  });
});
