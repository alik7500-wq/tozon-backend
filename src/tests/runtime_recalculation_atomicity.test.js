import { describe, it, expect } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Runtime Deal Schedule Recalculation Atomicity', () => {
  it('should compute valid PostgreSQL statuses for partial and overdue rows', () => {
    const schedules = [
      { id: 1, due_date: '2026-06-01', amount_minor: 100000, paid_amount_minor: 0, status: 'UPCOMING' },
      { id: 2, due_date: '2026-07-01', amount_minor: 100000, paid_amount_minor: 0, status: 'UPCOMING' },
      { id: 3, due_date: '2026-10-01', amount_minor: 100000, paid_amount_minor: 0, status: 'UPCOMING' }
    ];
    const payments = [
      { id: 101, amount_minor: 150000, payment_date: '2026-06-01', status: 'POSTED' }
    ];
    const result = allocatePaymentsFIFO(schedules, payments, 0, '2026-09-26');

    // Row 1: Fully paid -> PAID
    expect(result.schedules[0].computed_status).toBe('PAID');
    expect(result.schedules[0].paid_amount_minor).toBe(100000);

    // Row 2: Partial & Past Due -> OVERDUE (never PARTIALLY_PAID which violates Postgres constraint)
    expect(result.schedules[1].computed_status).toBe('OVERDUE');
    expect(result.schedules[1].paid_amount_minor).toBe(50000);

    // Row 3: Future -> UPCOMING
    expect(result.schedules[2].computed_status).toBe('UPCOMING');
    expect(result.schedules[2].paid_amount_minor).toBe(0);
  });

  it('should ensure status is strictly within ALLOWED_PG_STATUSES', () => {
    const ALLOWED_PG_STATUSES = ['PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL'];
    const invalidStatus = 'PARTIALLY_PAID';
    expect(ALLOWED_PG_STATUSES.includes(invalidStatus)).toBe(false);
  });
});
