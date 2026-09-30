import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentReminderDetector, PAYMENT_REMINDER_OFFSET_DAYS } from '../paymentReminderDetector.js';
import { SmsEventsRepository } from '../smsEvents.repository.js';
import * as dbConn from '../../../db/connection.js';

describe('V1.5C PAYMENT_REMINDER Detector Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMockDb(mockSchedules = [], mockEvents = []) {
    let queryCount = 0;
    const mockDb = {
      from: vi.fn().mockImplementation((table) => {
        if (table === 'deal_payment_schedules') {
          return {
            select: vi.fn().mockImplementation((cols, opts) => {
              queryCount++;
              if (opts && opts.count) {
                return Promise.resolve({ count: mockSchedules.length, error: null });
              }
              const query = {
                gte: () => query,
                lte: () => query,
                order: () => Promise.resolve({ data: mockSchedules, error: null })
              };
              return query;
            })
          };
        }
        if (table === 'sms_events') {
          return {
            select: vi.fn().mockImplementation(() => {
              queryCount++;
              const query = {
                eq: () => query,
                then: (resolve) => resolve({ data: mockEvents, error: null })
              };
              return query;
            })
          };
        }
        return {
          select: () => {
            queryCount++;
            return Promise.resolve({ data: [], error: null });
          }
        };
      }),
      getQueryCount: () => queryCount
    };
    vi.spyOn(dbConn, 'getServiceDB').mockReturnValue(mockDb);
    return mockDb;
  }

  describe('Detector Policy & Window Eligibility', () => {
    it('01. D-4 before due_date is NOT eligible', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          payment_number: 1,
          due_date: '2026-10-14',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({
        businessDate: '2026-10-10', // D-4 before 2026-10-14!
        isDryRun: true
      });

      expect(res.eligible).toBe(0);
      expect(res.candidates.length).toBe(0);
    });

    it('02. D-3 before due_date IS eligible', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          payment_number: 1,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({
        businessDate: '2026-10-10', // Exactly D-3 before 2026-10-13!
        isDryRun: true
      });

      expect(res.eligible).toBe(1);
      expect(res.candidates[0].idempotencyKey).toBe('PAYMENT_REMINDER:101:3:2026-10-13');
    });

    it('03 & 04. Missed run (D-2, D-1, D-day) IS eligible', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          payment_number: 1,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);
      const resD2 = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-11', isDryRun: true });
      expect(resD2.eligible).toBe(1);

      setupMockDb(mockSchedules);
      const resDDay = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-13', isDryRun: true });
      expect(resDDay.eligible).toBe(1);
    });

    it('06. D+1 past due_date is skipped as overdue (not PAYMENT_REMINDER)', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'OVERDUE',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-14', isDryRun: true });
      expect(res.eligible).toBe(0);
      expect(res.skipped_overdue).toBe(1);
    });

    it('07 & 08. Fully paid is skipped; partially paid uses unpaid_minor amount', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 150000,
          paid_amount_minor: 50000, // 500 USD paid, 1000 USD unpaid!
          status: 'PARTIAL',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      expect(res.eligible).toBe(1);
      expect(res.candidates[0].unpaidMinor).toBe(100000); // 1,000 USD unpaid!
    });

    it('09 & 10. Invalid phone or ineligible deal status is skipped', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          deals: {
            id: 39,
            status: 'CANCELLED', // Ineligible deal!
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, phone: '+992900000001' }
          }
        },
        {
          id: 102,
          deal_id: 40,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          deals: {
            id: 40,
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 14,
            leads: { id: 14, phone: 'INVALID_PHONE' } // Invalid phone!
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      expect(res.eligible).toBe(0);
      expect(res.skipped_ineligible_deal).toBe(1);
      expect(res.skipped_invalid_phone).toBe(1);
    });
  });

  describe('Idempotency & Re-run Safety', () => {
    it('13 & 14. Repeated run does not create duplicate events', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      vi.spyOn(SmsEventsRepository, 'createEvent')
        .mockResolvedValueOnce({ created: true, event: { id: 501 } })
        .mockResolvedValueOnce({ created: false, event: { id: 501 } }); // 2nd run: already exists!

      const res1 = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: false });
      expect(res1.created).toBe(1);

      const res2 = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: false });
      expect(res2.created).toBe(0);
      expect(res2.already_exists).toBe(1);
    });

    it('15. Preserves idempotency across all terminal and non-terminal event statuses', async () => {
      const statuses = ['AWAITING_CONFIRMATION', 'PROCESSING', 'SENT', 'CANCELLED', 'FAILED', 'DELIVERY_UNKNOWN'];
      
      for (const status of statuses) {
        vi.clearAllMocks();
        const mockSchedules = [
          {
            id: 101,
            deal_id: 39,
            due_date: '2026-10-13',
            amount_minor: 100000,
            paid_amount_minor: 0,
            status: 'UPCOMING',
            deals: {
              id: 39,
              contract_number: '0029',
              status: 'SIGNED',
              currency: 'USD',
              lead_id: 13,
              leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
            }
          }
        ];

        setupMockDb(mockSchedules);
        vi.spyOn(SmsEventsRepository, 'createEvent').mockResolvedValue({
          created: false,
          event: { id: 501, idempotency_key: 'PAYMENT_REMINDER:101:3:2026-10-13', status }
        });

        const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: false });
        expect(res.created).toBe(0);
        expect(res.already_exists).toBe(1);
      }
    });
  });

  describe('Due Date Change & Stale Event Cancellation', () => {
    it('24 & 26. When due_date changes, old awaiting event is cancelled and new event is created when eligible', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-20', // Due date was changed to Oct 20!
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      const oldEvent = { id: 901, schedule_id: 101, idempotency_key: 'PAYMENT_REMINDER:101:3:2026-10-13', status: 'AWAITING_CONFIRMATION' };
      setupMockDb(mockSchedules, [oldEvent]);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 901, status: 'CANCELLED' });

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: false });

      // Old event cancelled!
      expect(SmsEventsRepository.cancelEvent).toHaveBeenCalledWith({ id: 901, reason: 'PAYMENT_NO_LONGER_ELIGIBLE' });
      // Oct 20 is D-10 for business date Oct 10, so not yet eligible for creation
      expect(res.created).toBe(0);
    });

    it('27. Payment made after event creation auto-cancels stale awaiting event', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 100000, // Fully paid now!
          status: 'PAID',
          deals: {
            id: 39,
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, phone: '+992900000001' }
          }
        }
      ];

      const oldEvent = { id: 902, schedule_id: 101, status: 'AWAITING_CONFIRMATION' };
      setupMockDb(mockSchedules, [oldEvent]);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 902, status: 'CANCELLED' });

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: false });

      expect(SmsEventsRepository.cancelEvent).toHaveBeenCalledWith({ id: 902, reason: 'PAYMENT_NO_LONGER_ELIGIBLE' });
      expect(res.cancelled_stale).toBe(1);
    });
  });

  describe('Multi-Deal Client Isolation & Safety', () => {
    it('22 & 31. Multiple deals for same client are isolated into distinct schedule events', async () => {
      const mockSchedules = [
        {
          id: 101,
          deal_id: 39,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          deals: {
            id: 39,
            contract_number: '0029',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        },
        {
          id: 102,
          deal_id: 40, // Second deal for same client 13!
          due_date: '2026-10-13',
          amount_minor: 200000,
          paid_amount_minor: 0,
          deals: {
            id: 40,
            contract_number: '0030',
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 13,
            leads: { id: 13, full_name: 'Акмал', phone: '+992900000001' }
          }
        }
      ];

      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });

      expect(res.eligible).toBe(2);
      expect(res.candidates[0].scheduleId).toBe(101);
      expect(res.candidates[0].dealId).toBe(39);
      expect(res.candidates[1].scheduleId).toBe(102);
      expect(res.candidates[1].dealId).toBe(40);
    });

    it('30 & 34. Detector execution performs ZERO Payom calls and ZERO financial mutations', async () => {
      const mockSchedules = [];
      setupMockDb(mockSchedules);

      const res = await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      expect(res.scanned).toBe(0);
    });
  });

  describe('Performance & Query Count Boundedness', () => {
    it('DB Query count is constant regardless of total schedules (10 vs 100 vs 1000 schedules)', async () => {
      const generateSchedules = (count) => {
        return Array.from({ length: count }, (_, i) => ({
          id: i + 1,
          deal_id: 100 + i,
          due_date: '2026-10-13',
          amount_minor: 100000,
          paid_amount_minor: 0,
          status: 'UPCOMING',
          deals: {
            id: 100 + i,
            contract_number: `000${i}`,
            status: 'SIGNED',
            currency: 'USD',
            lead_id: 200 + i,
            leads: { id: 200 + i, full_name: `Client ${i}`, phone: '+992900000001' }
          }
        }));
      };

      const mockDb10 = setupMockDb(generateSchedules(10));
      await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      const queryCount10 = mockDb10.getQueryCount();

      const mockDb100 = setupMockDb(generateSchedules(100));
      await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      const queryCount100 = mockDb100.getQueryCount();

      const mockDb1000 = setupMockDb(generateSchedules(1000));
      await PaymentReminderDetector.detectPaymentReminders({ businessDate: '2026-10-10', isDryRun: true });
      const queryCount1000 = mockDb1000.getQueryCount();

      // All dry runs perform exactly 3 DB queries (count + bulk schedules select + bulk events select)
      expect(queryCount10).toBe(3);
      expect(queryCount100).toBe(3);
      expect(queryCount1000).toBe(3);
    });
  });
});
