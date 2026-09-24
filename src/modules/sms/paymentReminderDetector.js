import { getServiceDB } from '../../db/connection.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalizer.js';
import { SmsEventsRepository } from './smsEvents.repository.js';
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
   * Creates PAYMENT_REMINDER sms_events in AWAITING_CONFIRMATION status.
   * Payom calls = 0.
   */
  static async detectPaymentReminders({ businessDate = null, isDryRun = false } = {}) {
    const effectiveBusinessDate = businessDate || getBusinessDate();
    const db = getServiceDB();

    const { data: rawSchedules, error } = await db
      .from('deal_payment_schedules')
      .select(`
        *,
        deals!inner (
          id,
          contract_number,
          status,
          currency,
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
      .order('due_date', { ascending: true });

    if (error) {
      console.error('DB error fetching schedules for reminder detector:', error.message);
      throw new AppError(`DB error in payment reminder detector: ${error.message}`, 500);
    }

    const stats = {
      businessDate: effectiveBusinessDate,
      scanned: 0,
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

    for (const sched of (rawSchedules || [])) {
      stats.scanned++;

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
        
        if (!isDryRun && scheduleId) {
          const existingEvents = await SmsEventsRepository.listEvents({
            scheduleId,
            eventType: 'PAYMENT_REMINDER',
            status: 'AWAITING_CONFIRMATION',
            limit: 10
          });
          for (const ev of (existingEvents.events || [])) {
            await SmsEventsRepository.cancelEvent({ id: ev.id, reason: 'PAYMENT_ALREADY_PAID' });
            stats.cancelled_stale++;
          }
        }
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

      if (!isDryRun && scheduleId) {
        const existingAwaiting = await SmsEventsRepository.listEvents({
          scheduleId,
          eventType: 'PAYMENT_REMINDER',
          status: 'AWAITING_CONFIRMATION',
          limit: 10
        });

        for (const ev of (existingAwaiting.events || [])) {
          if (ev.idempotency_key !== expectedIdempotencyKey) {
            await SmsEventsRepository.cancelEvent({ id: ev.id, reason: 'PAYMENT_DUE_DATE_CHANGED' });
            stats.cancelled_stale++;
          }
        }
      }

      const reminderMinDate = addDaysToDateStr(dueDate, -PAYMENT_REMINDER_OFFSET_DAYS);
      
      if (dueDate < effectiveBusinessDate) {
        stats.skipped_overdue++;
        continue;
      }

      const isEligibleWindow = effectiveBusinessDate >= reminderMinDate && effectiveBusinessDate <= dueDate;
      if (!isEligibleWindow) {
        continue;
      }

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

      if (isDryRun) {
        continue;
      }

      try {
        const result = await SmsEventsRepository.createEvent({
          event_type: 'PAYMENT_REMINDER',
          idempotency_key: expectedIdempotencyKey,
          mode: 'CONFIRM',
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

    return stats;
  }
}
