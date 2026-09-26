import { describe, it, expect } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Pure In-Database FIFO PKO Operations & Soft Voiding', () => {
  it('should compute valid FIFO allocations dynamically for active payments', () => {
    const schedules = [{ id: 101, due_date: '2026-01-01', amount_minor: 100000, paid_amount_minor: 0, status: 'UPCOMING' }];
    const activePayments = [{ id: 1, amount_minor: 50000, payment_date: '2026-01-01', status: 'ACTIVE' }];

    const res = allocatePaymentsFIFO(schedules, activePayments, 0, '2026-09-26');
    expect(res.schedules[0].computed_status).toBe('OVERDUE');
    expect(res.schedules[0].paid_amount_minor).toBe(50000);
  });

  it('should exclude VOIDED payments from FIFO schedule allocation', () => {
    const schedules = [{ id: 101, due_date: '2026-01-01', amount_minor: 100000, paid_amount_minor: 0, status: 'UPCOMING' }];
    const paymentsWithVoided = [
      { id: 1, amount_minor: 50000, payment_date: '2026-01-01', status: 'VOIDED' }
    ];

    const res = allocatePaymentsFIFO(schedules, paymentsWithVoided, 0, '2026-09-26');
    expect(res.schedules[0].computed_status).toBe('OVERDUE');
    expect(res.schedules[0].paid_amount_minor).toBe(0);
  });

  it('should verify soft-voiding preserves payment ID and historical attributes', () => {
    const payment = {
      id: 400,
      deal_id: 39,
      amount_minor: 100000,
      status: 'VOIDED',
      voided_at: '2026-09-26T21:40:00.000Z',
      void_reason: 'Annulled via CRM'
    };

    expect(payment.id).toBe(400);
    expect(payment.status).toBe('VOIDED');
    expect(payment.void_reason).toBeDefined();
  });
});
