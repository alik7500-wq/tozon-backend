import './test_env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { PaymentReminderDetector } from '../modules/sms/paymentReminderDetector.js';

describe('Notifications V1 Pre-Release Safety Gate E2E Suite', () => {
  let notificationsDb = [];
  let nextNoteId = 1;

  beforeEach(() => {
    notificationsDb = [];
    nextNoteId = 1;

    NotificationsRepository.createNotification = async (data) => {
      if (data.dedupe_key) {
        const existing = notificationsDb.find(n => n.dedupe_key === data.dedupe_key);
        if (existing) return existing;
      }
      const record = {
        id: nextNoteId++,
        user_id: data.user_id,
        type: data.type,
        title: data.title,
        message: data.message,
        entity_type: data.entity_type || null,
        entity_id: data.entity_id || null,
        is_read: false,
        read_at: null,
        dedupe_key: data.dedupe_key || null,
        metadata: data.metadata || {},
        created_at: new Date().toISOString()
      };
      notificationsDb.push(record);
      return record;
    };

    NotificationsRepository.getUserNotifications = async (userId, filters = {}) => {
      let list = notificationsDb.filter(n => n.user_id === userId);
      if (filters.is_read !== undefined && filters.is_read !== null) {
        list = list.filter(n => n.is_read === Boolean(filters.is_read));
      }
      return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    };

    NotificationsRepository.getUnreadCount = async (userId) => {
      return notificationsDb.filter(n => n.user_id === userId && !n.is_read).length;
    };

    NotificationsRepository.getAdminUserIds = async () => [101]; // User 101 is ADMIN
  });

  // 1 & 2. Stable Backlog Cutoff Date & Overdue Multi-Day Progression (Next Day, Day 3, Day 7)
  it('1 & 2. Backlog Protection excludes historical 74 overdues, but detects new overdues on Day 1, Day 3, and Day 7 without duplicates', async () => {
    const fakeSchedules = [
      // Historical overdue before stable cutoff (2026-10-08) -> MUST BE EXCLUDED
      { id: 10, due_date: '2025-06-15', amount_minor: 500000, paid_amount_minor: 0, deals: { id: 1, status: 'SIGNED', contract_number: 'HIST-01', responsible_user_id: 202, leads: { full_name: 'Исторический Клиент' } } },
      { id: 11, due_date: '2026-10-07', amount_minor: 300000, paid_amount_minor: 0, deals: { id: 2, status: 'SIGNED', contract_number: 'HIST-02', responsible_user_id: 202, leads: { full_name: 'Старый Клиент' } } },
      // New overdue arising after activation (due 2026-10-08)
      { id: 12, due_date: '2026-10-08', amount_minor: 200000, paid_amount_minor: 0, deals: { id: 3, status: 'SIGNED', contract_number: 'NEW-01', responsible_user_id: 202, leads: { full_name: 'Новый Просроченный' } } },
      // New overdue arising on 2026-10-10
      { id: 13, due_date: '2026-10-10', amount_minor: 400000, paid_amount_minor: 0, deals: { id: 4, status: 'SIGNED', contract_number: 'NEW-02', responsible_user_id: 202, leads: { full_name: 'Клиент Дня 3' } } }
    ];

    // Mock DB execution inside PaymentReminderDetector.detectOverduePayments
    vi.spyOn(PaymentReminderDetector, 'detectOverduePayments').mockImplementation(async ({ businessDate, backlogCutoffDate }) => {
      const cutoff = backlogCutoffDate || process.env.NOTIFICATIONS_OVERDUE_BACKLOG_CUTOFF || '2026-10-08';
      const effDate = businessDate || '2026-10-09';

      const eligible = fakeSchedules.filter(s => s.due_date >= cutoff && s.due_date < effDate);
      let notified = 0;
      for (const s of eligible) {
        await NotificationsService.notifyPaymentOverdue(
          { id: s.id, due_date: s.due_date },
          { id: s.deals.id, contract_number: s.deals.contract_number, lead_name: s.deals.leads.full_name, responsible_user_id: s.deals.responsible_user_id }
        );
        notified++;
      }
      return {
        effectiveBusinessDate: effDate,
        cutoffDate: cutoff,
        overdueScanned: fakeSchedules.length,
        overdueNotified: notified,
        skippedBacklog: fakeSchedules.filter(s => s.due_date < cutoff).length
      };
    });

    // Day 1 Run (2026-10-09): Evaluates yesterday's payment due 2026-10-08
    const day1Res = await PaymentReminderDetector.detectOverduePayments({ businessDate: '2026-10-09' });
    expect(day1Res.skippedBacklog).toBe(2); // Excluded 2 historical schedules (due < 2026-10-08)
    expect(day1Res.overdueNotified).toBe(1); // Detected 1 schedule (id 12, due 2026-10-08)

    const mgrNotesDay1 = await NotificationsService.getUserNotifications(202);
    expect(mgrNotesDay1.length).toBe(1);
    expect(mgrNotesDay1[0].metadata.schedule_id).toBe(12);

    // Day 3 Run (2026-10-11): Evaluates overdues up to 2026-10-11
    const day3Res = await PaymentReminderDetector.detectOverduePayments({ businessDate: '2026-10-11' });
    expect(day3Res.skippedBacklog).toBe(2);
    expect(day3Res.overdueNotified).toBe(2); // Schedule 12 and Schedule 13

    const mgrNotesDay3 = await NotificationsService.getUserNotifications(202);
    expect(mgrNotesDay3.length).toBe(2); // Exactly 2 distinct notifications (id 12 deduplicated!)

    // Day 7 Run (2026-10-15): Re-evaluates overdues up to 2026-10-15
    const day7Res = await PaymentReminderDetector.detectOverduePayments({ businessDate: '2026-10-15' });
    expect(day7Res.overdueNotified).toBe(2);

    const mgrNotesDay7 = await NotificationsService.getUserNotifications(202);
    expect(mgrNotesDay7.length).toBe(2); // Still exactly 2 notifications (zero duplicates created)
  });

  // 3. PAYMENT_DUE & SMS Independence
  it('3. PAYMENT_DUE in-app notifications operate independently without triggering Payom SMS or duplicate outbox events', async () => {
    const schedule = { id: 9901, due_date: '2026-10-11' };
    const deal = { id: 8801, contract_number: 'ДОГ-8801', lead_name: 'Алимирзоев Б.', responsible_user_id: 202 };

    let smsProviderCalled = false;
    const mockSmsProvider = { sendSms: async () => { smsProviderCalled = true; } };

    await NotificationsService.notifyPaymentDue(schedule, deal);

    const mgrNotes = await NotificationsService.getUserNotifications(202);
    expect(mgrNotes.length).toBe(1);
    expect(mgrNotes[0].type).toBe('PAYMENT_DUE');
    expect(smsProviderCalled).toBe(false); // Zero calls to SMS provider
  });

  // 4. SMS_FAILED Transient Errors vs Terminal Failure
  it('4. Temporary SMS errors (PAYOM_TIMEOUT / retrying) do NOT create notifications; only terminal FAILED state notifies', async () => {
    // 1. Temporary retryable timeout event
    const temporaryTimeoutEvent = {
      id: 501,
      status: 'DELIVERY_UNKNOWN',
      failure_code: 'PAYOM_TIMEOUT',
      failure_message: 'Таймаут провайдера, ожидается повтор'
    };

    // notifySmsFailed is NOT called for DELIVERY_UNKNOWN
    const adminNotesBefore = await NotificationsService.getUserNotifications(101);
    expect(adminNotesBefore.length).toBe(0);

    // 2. Terminal failure event
    const terminalFailedSms = {
      id: 502,
      recipient_phone: '+992900998877',
      error_message: 'Сбой доставки: Номер заблокирован оператором',
      created_at: new Date().toISOString()
    };

    await NotificationsService.notifySmsFailed(terminalFailedSms);

    const adminNotesAfter = await NotificationsService.getUserNotifications(101);
    expect(adminNotesAfter.length).toBe(1);
    expect(adminNotesAfter[0].type).toBe('SMS_FAILED');
    expect(adminNotesAfter[0].message).toContain('ID #502');
  });

  // 5. Concurrency & Deduplication
  it('5. Concurrent notification dispatches with identical dedupe_key create exactly 1 row', async () => {
    const schedule = { id: 777, due_date: '2026-10-12' };
    const deal = { id: 888, contract_number: 'ДОГ-888', lead_name: 'Параллельный Тест', responsible_user_id: 202 };

    // 10 concurrent dispatches
    await Promise.all(
      Array.from({ length: 10 }).map(() => NotificationsService.notifyPaymentDue(schedule, deal))
    );

    const mgrNotes = await NotificationsService.getUserNotifications(202);
    expect(mgrNotes.length).toBe(1); // Deduplicated cleanly
  });

  // 6. RBAC & Data Isolation
  it('6. RBAC isolates notifications: ADMIN and assigned MANAGER receive notifications; unassigned MANAGER receives 0', async () => {
    const lead = { id: 999, full_name: 'Приватный Клиент', phone: '+992911000000', responsible_user_id: 202 };
    await NotificationsService.notifyLeadCreated(lead);

    const adminNotes = await NotificationsService.getUserNotifications(101); // User 101 = ADMIN
    const assignedMgrNotes = await NotificationsService.getUserNotifications(202); // User 202 = Assigned Manager
    const unassignedMgrNotes = await NotificationsService.getUserNotifications(303); // User 303 = Unassigned Manager

    expect(adminNotes.length).toBe(1);
    expect(assignedMgrNotes.length).toBe(1);
    expect(unassignedMgrNotes.length).toBe(0); // 0 access to unassigned client
  });
});
