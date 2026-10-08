import { getServiceDB } from '../../db/connection.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalizer.js';
import { SmsEventsRepository } from './smsEvents.repository.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export const PAYMENT_REMINDER_OFFSET_DAYS = 3;

function addDaysToDateStr(dateStr, days) {
  const dt = new Date(`${dateStr}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split('T')[0];
}

export class PaymentReminderDetector {
  /**
   * Scan payment schedules and detect upcoming installment payment reminders.
   * Dispatches both SMS outbox events and internal in-app PAYMENT_DUE notifications.
   */
  static async detectPaymentReminders({ businessDate = null, isDryRun = false } = {}) {
    const effectiveBusinessDate = businessDate || getBusinessDate();
    const db = getServiceDB();

    const maxDueDate = addDaysToDateStr(effectiveBusinessDate, PAYMENT_REMINDER_OFFSET_DAYS);

    // 1. Fetch total schedules count for operational metrics
    const { count: totalScanned, error: countErr } = await db
      .from('deal_payment_schedules')
      .select('*', { count: 'exact', head: true });

    if (countErr) {
      console.error('DB error fetching total schedules count:', countErr.message);
      throw new AppError(`DB error in payment reminder detector: ${countErr.message}`, 500);
    }

    // 2. Bulk fetch candidate schedules in the due_date window [effectiveBusinessDate, maxDueDate]
    const { data: rawSchedules, error: schedErr } = await db
      .from('deal_payment_schedules')
      .select(`
        *,
        deals!inner (
          id,
          contract_number,
          status,
          currency,
          responsible_user_id,
          final_price_minor,
          lead_id,
          leads!inner (
            id,
            full_name,
            phone,
            secondary_phone
          )
        )
      `)
      .gte('due_date', effectiveBusinessDate)
      .lte('due_date', maxDueDate)
      .order('due_date', { ascending: true });

    if (schedErr) {
      console.error('DB error fetching schedules for reminder detector:', schedErr.message);
      throw new AppError(`DB error in payment reminder detector: ${schedErr.message}`, 500);
    }

    // 3. Bulk fetch active AWAITING_CONFIRMATION events for PAYMENT_REMINDER
    const { data: awaitingEvents, error: evErr } = await db
      .from('sms_events')
      .select('id, schedule_id, idempotency_key, status')
      .eq('event_type', 'PAYMENT_REMINDER')
      .eq('status', 'AWAITING_CONFIRMATION');

    if (evErr) {
      console.error('DB error fetching awaiting events for reminder detector:', evErr.message);
      throw new AppError(`DB error fetching awaiting events: ${evErr.message}`, 500);
    }

    // Group active awaiting events by schedule_id
    const awaitingByScheduleId = new Map();
    for (const ev of (awaitingEvents || [])) {
      const schedId = parseOptionalBigInt(ev.schedule_id);
      if (schedId) {
        if (!awaitingByScheduleId.has(schedId)) {
          awaitingByScheduleId.set(schedId, []);
        }
        awaitingByScheduleId.get(schedId).push(ev);
      }
    }

    const stats = {
      businessDate: effectiveBusinessDate,
      scanned: totalScanned || 0,
      eligible: 0,
      created: 0,
      already_exists: 0,
      cancelled_stale: 0,
      skipped_paid: 0,
      skipped_overdue: 0,
      skipped_invalid_phone: 0,
      skipped_ineligible_deal: 0,
      errors: 0,
      candidates: []
    };

    const eligibleDeals = ['SIGNED'];
    const validScheduleIdsInWindow = new Set();

    for (const sched of (rawSchedules || [])) {
      const deal = sched.deals;
      const lead = deal?.leads;
      const scheduleId = parseOptionalBigInt(sched.id);
      const dealId = parseOptionalBigInt(sched.deal_id);
      const clientId = parseOptionalBigInt(deal?.lead_id);
      const dueDate = sched.due_date;

      const amountMinor = Number(sched.amount_minor) || 0;
      const paidMinor = Number(sched.paid_amount_minor) || 0;
      const unpaidMinor = Math.max(0, amountMinor - paidMinor);

      if (unpaidMinor <= 0 || sched.status === 'PAID') {
        stats.skipped_paid++;
        continue;
      }

      if (!deal || !eligibleDeals.includes(deal.status)) {
        stats.skipped_ineligible_deal++;
        continue;
      }

      const rawPhone = lead?.phone || lead?.secondary_phone;
      const phoneNorm = normalizePhoneNumber(rawPhone);
      if (!phoneNorm.isValid) {
        stats.skipped_invalid_phone++;
        continue;
      }

      const expectedIdempotencyKey = `PAYMENT_REMINDER:${scheduleId}:3:${dueDate}`;
      const reminderMinDate = addDaysToDateStr(dueDate, -PAYMENT_REMINDER_OFFSET_DAYS);

      if (dueDate < effectiveBusinessDate) {
        stats.skipped_overdue++;
        continue;
      }

      const isEligibleWindow = effectiveBusinessDate >= reminderMinDate && effectiveBusinessDate <= dueDate;
      if (!isEligibleWindow) {
        continue;
      }

      validScheduleIdsInWindow.add(scheduleId);
      stats.eligible++;

      const candidateObj = {
        scheduleId,
        dealId,
        clientId,
        contractNumber: deal.contract_number,
        dueDate,
        unpaidMinor,
        unpaidAmountFormatted: (unpaidMinor / 100).toLocaleString('ru-RU'),
        currency: (deal.currency || 'USD').toUpperCase(),
        idempotencyKey: expectedIdempotencyKey
      };

      stats.candidates.push(candidateObj);

      // Dispatch internal in-app PAYMENT_DUE notification safely
      if (!isDryRun && scheduleId && dealId) {
        NotificationsService.notifyPaymentDue(
          { id: scheduleId, due_date: dueDate },
          {
            id: dealId,
            contract_number: deal.contract_number,
            lead_name: lead?.full_name || 'Клиент',
            responsible_user_id: deal.responsible_user_id
          }
        ).catch(err => {
          console.warn(`Failed to dispatch PAYMENT_DUE notification for schedule ${scheduleId}:`, err.message);
        });
      }

      // Stale event check for this eligible schedule
      if (!isDryRun && scheduleId && awaitingByScheduleId.has(scheduleId)) {
        const existingList = awaitingByScheduleId.get(scheduleId);
        for (const ev of existingList) {
          if (ev.idempotency_key !== expectedIdempotencyKey) {
            await SmsEventsRepository.cancelEvent({ id: ev.id, reason: 'PAYMENT_DUE_DATE_CHANGED' });
            stats.cancelled_stale++;
          }
        }
      }

      if (isDryRun) {
        continue;
      }

      try {
        const isAutoEnabled = process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED === 'true';
        const targetMode = isAutoEnabled ? 'AUTO' : 'CONFIRM';

        const result = await SmsEventsRepository.createEvent({
          event_type: 'PAYMENT_REMINDER',
          idempotency_key: expectedIdempotencyKey,
          mode: targetMode,
          status: 'AWAITING_CONFIRMATION',
          client_id: clientId,
          deal_id: dealId,
          schedule_id: scheduleId,
          template_code: 'PAYMENT_REMINDER',
          payload_json: {
            detected_business_date: effectiveBusinessDate,
            detected_due_date: dueDate,
            detected_unpaid_minor: unpaidMinor,
            offset_days: PAYMENT_REMINDER_OFFSET_DAYS,
            audit_note: 'PAYLOAD_IS_NOT_SOURCE_OF_TRUTH'
          },
          scheduled_at: new Date().toISOString(),
          available_at: new Date().toISOString()
        });

        if (result.created) {
          stats.created++;
        } else {
          stats.already_exists++;
        }
      } catch (err) {
        console.error(`Error creating event for schedule ${scheduleId}:`, err.message);
        stats.errors++;
      }
    }

    // Clean up stale awaiting events for schedules no longer in the window or paid
    if (!isDryRun) {
      for (const [schedId, evList] of awaitingByScheduleId.entries()) {
        if (!validScheduleIdsInWindow.has(schedId)) {
          for (const ev of evList) {
            await SmsEventsRepository.cancelEvent({ id: ev.id, reason: 'PAYMENT_NO_LONGER_ELIGIBLE' });
            stats.cancelled_stale++;
          }
        }
      }
    }

    return stats;
  }

  /**
   * Detect overdue payment schedules and dispatch internal PAYMENT_OVERDUE in-app notifications.
   * Features Backlog Protection Gate: historical overdue records before backlogCutoffDate are skipped.
   */
  static async detectOverduePayments({ businessDate = null, isDryRun = false, backlogCutoffDate = null } = {}) {
    const effectiveBusinessDate = businessDate || getBusinessDate();
    const db = getServiceDB();

    // BACKLOG PROTECTION GATE: Stable fixed release date (2026-10-08) excludes historical 74 overdues
    // while ensuring any new overdues arising after activation are detected cleanly across 1, 3, 7 day runs.
    const DEFAULT_STABLE_BACKLOG_CUTOFF = '2026-10-08';
    const cutoffDate = backlogCutoffDate || process.env.NOTIFICATIONS_OVERDUE_BACKLOG_CUTOFF || DEFAULT_STABLE_BACKLOG_CUTOFF;

    const { data: overdueSchedules, error } = await db
      .from('deal_payment_schedules')
      .select(`
        *,
        deals!inner (
          id,
          contract_number,
          status,
          currency,
          responsible_user_id,
          lead_id,
          leads!inner (
            id,
            full_name,
            phone
          )
        )
      `)
      .lt('due_date', effectiveBusinessDate)
      .gte('due_date', cutoffDate) // Backlog protection filter
      .order('due_date', { ascending: true });

    if (error) {
      console.error('DB error fetching overdue schedules:', error.message);
      return { overdueScanned: 0, overdueNotified: 0, skippedBacklog: 0 };
    }

    const eligibleDeals = ['SIGNED'];
    let notifiedCount = 0;
    let skippedPaidCount = 0;

    for (const sched of (overdueSchedules || [])) {
      const deal = sched.deals;
      const lead = deal?.leads;
      const scheduleId = parseOptionalBigInt(sched.id);
      const dealId = parseOptionalBigInt(sched.deal_id);

      const amountMinor = Number(sched.amount_minor) || 0;
      const paidMinor = Number(sched.paid_amount_minor) || 0;
      const unpaidMinor = Math.max(0, amountMinor - paidMinor);

      if (unpaidMinor <= 0 || sched.status === 'PAID') {
        skippedPaidCount++;
        continue;
      }

      if (!deal || !eligibleDeals.includes(deal.status)) {
        continue;
      }

      if (!isDryRun && scheduleId && dealId) {
        await NotificationsService.notifyPaymentOverdue(
          { id: scheduleId, due_date: sched.due_date },
          {
            id: dealId,
            contract_number: deal.contract_number,
            lead_name: lead?.full_name || 'Клиент',
            responsible_user_id: deal.responsible_user_id
          }
        ).catch(err => {
          console.warn(`Failed to dispatch PAYMENT_OVERDUE notification for schedule ${scheduleId}:`, err.message);
        });
        notifiedCount++;
      }
    }

    return {
      effectiveBusinessDate,
      cutoffDate,
      overdueScanned: (overdueSchedules || []).length,
      overdueNotified: notifiedCount,
      skippedPaid: skippedPaidCount
    };
  }
}
