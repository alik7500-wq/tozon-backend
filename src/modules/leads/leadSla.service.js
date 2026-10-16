/**
 * TOZON CRM — Sales Launch Phase 2
 * Lead First-Contact SLA Service (15-Minute Control)
 * 
 * Rules:
 * - Sales working window: 09:00 - 18:00 Asia/Dushanbe (UTC+5)
 * - Working days: Monday - Saturday (Sunday off)
 * - SLA First Contact: 15 working minutes
 * - Strictly separates Pool SLA (pre-assignment) vs Manager SLA (post-assignment)
 * - Non-working hours & Sundays do NOT create false breaches
 */

import { BUSINESS_TIMEZONE } from '../../utils/businessTime.js';

export const SALES_WORK_HOURS = {
  START: 9, // 09:00 Asia/Dushanbe
  END: 18   // 18:00 Asia/Dushanbe
};

export const SLA_FIRST_CONTACT_MINUTES = 15;
export const SLA_WARNING_THRESHOLD_MINUTES = 10;

const DUSHANBE_OFFSET_MS = 5 * 3600 * 1000;

/**
 * Returns true if the day of week (in Dushanbe time) is a working day (Mon-Sat, Sun is off).
 */
export function isSalesBusinessDay(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const local = new Date(d.getTime() + DUSHANBE_OFFSET_MS);
  const day = local.getUTCDay(); // 0 is Sunday
  return day !== 0;
}

/**
 * Advances the date to the next valid working minute if currently outside business hours.
 * - If before 09:00 on working day -> same day 09:00
 * - If at or after 18:00 or Sunday -> next working day 09:00
 */
export function normalizeToSalesWorkingWindow(dateInput) {
  const d = new Date(dateInput);
  let local = new Date(d.getTime() + DUSHANBE_OFFSET_MS);

  while (true) {
    const day = local.getUTCDay();
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();

    if (day === 0) {
      // Sunday -> move to Monday 09:00
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(SALES_WORK_HOURS.START, 0, 0, 0);
      continue;
    }

    if (hour < SALES_WORK_HOURS.START) {
      // Before 09:00 -> advance to 09:00 today
      local.setUTCHours(SALES_WORK_HOURS.START, 0, 0, 0);
      break;
    }

    if (hour >= SALES_WORK_HOURS.END) {
      // After 18:00 -> advance to next day 09:00
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(SALES_WORK_HOURS.START, 0, 0, 0);
      continue;
    }

    // Inside 09:00 - 18:00 on Mon-Sat
    break;
  }

  return new Date(local.getTime() - DUSHANBE_OFFSET_MS);
}

/**
 * Calculates working minutes elapsed between startInput and endInput (defaults to now)
 * within 09:00 - 18:00 Asia/Dushanbe, skipping Sundays and nights.
 */
export function calculateSalesWorkingMinutes(startInput, endInput = null) {
  if (!startInput) return 0;
  const start = new Date(startInput);
  const end = endInput ? new Date(endInput) : new Date();

  if (end <= start) return 0;

  let totalMinutes = 0;

  const startLocal = new Date(start.getTime() + DUSHANBE_OFFSET_MS);
  const endLocal = new Date(end.getTime() + DUSHANBE_OFFSET_MS);

  const currentDay = new Date(Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate()));
  const lastDay = new Date(Date.UTC(endLocal.getUTCFullYear(), endLocal.getUTCMonth(), endLocal.getUTCDate()));

  while (currentDay <= lastDay) {
    const y = currentDay.getUTCFullYear();
    const m = currentDay.getUTCMonth();
    const d = currentDay.getUTCDate();
    const dayOfWeek = currentDay.getUTCDay();

    // Sunday off
    if (dayOfWeek !== 0) {
      const dayStartUtcMs = Date.UTC(y, m, d, SALES_WORK_HOURS.START, 0, 0) - DUSHANBE_OFFSET_MS;
      const dayEndUtcMs = Date.UTC(y, m, d, SALES_WORK_HOURS.END, 0, 0) - DUSHANBE_OFFSET_MS;

      const windowStart = Math.max(start.getTime(), dayStartUtcMs);
      const windowEnd = Math.min(end.getTime(), dayEndUtcMs);

      if (windowEnd > windowStart) {
        totalMinutes += Math.floor((windowEnd - windowStart) / 60000);
      }
    }

    currentDay.setUTCDate(currentDay.getUTCDate() + 1);
  }

  return totalMinutes;
}

/**
 * Calculates the exact deadline Date by adding working minutes to startInput,
 * rolling over 18:00 and skipping Sundays.
 */
export function calculateSalesSlaDeadline(startInput, workingMinutesToAdd = SLA_FIRST_CONTACT_MINUTES) {
  if (!startInput) return null;
  let current = normalizeToSalesWorkingWindow(startInput);
  let remainingMinutes = workingMinutesToAdd;

  while (remainingMinutes > 0) {
    const local = new Date(current.getTime() + DUSHANBE_OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();

    const dayEndUtcMs = Date.UTC(y, m, d, SALES_WORK_HOURS.END, 0, 0) - DUSHANBE_OFFSET_MS;
    const availableTodayMinutes = Math.floor((dayEndUtcMs - current.getTime()) / 60000);

    if (availableTodayMinutes >= remainingMinutes) {
      current = new Date(current.getTime() + remainingMinutes * 60000);
      remainingMinutes = 0;
    } else {
      remainingMinutes -= Math.max(0, availableTodayMinutes);
      // Advance to next working day 09:00
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(SALES_WORK_HOURS.START, 0, 0, 0);
      current = normalizeToSalesWorkingWindow(new Date(local.getTime() - DUSHANBE_OFFSET_MS));
    }
  }

  return current;
}

/**
 * Comprehensive SLA evaluator for a lead
 */
export function evaluateLeadSla(lead, nowInput = null) {
  const now = nowInput ? new Date(nowInput) : new Date();
  const createdAt = lead.created_at ? new Date(lead.created_at) : now;
  const isUnassigned = !lead.responsible_user_id;

  // 1. POOL SLA: Time from created_at to assigned_at (or now if unassigned)
  const poolEnd = lead.assigned_at ? new Date(lead.assigned_at) : (isUnassigned ? now : createdAt);
  const poolWorkingMinutes = calculateSalesWorkingMinutes(createdAt, poolEnd);
  const poolDeadline = calculateSalesSlaDeadline(createdAt, SLA_FIRST_CONTACT_MINUTES);

  let poolStatus = 'POOL_ON_TRACK';
  if (isUnassigned) {
    if (poolWorkingMinutes > SLA_FIRST_CONTACT_MINUTES) {
      poolStatus = 'POOL_OVERDUE';
    } else if (poolWorkingMinutes >= SLA_WARNING_THRESHOLD_MINUTES) {
      poolStatus = 'POOL_WARNING';
    }
  } else {
    poolStatus = poolWorkingMinutes <= SLA_FIRST_CONTACT_MINUTES ? 'POOL_ASSIGNED_IN_TIME' : 'POOL_ASSIGNED_OVERDUE';
  }

  // 2. MANAGER SLA: Time from assigned_at to first_contact_at
  const hasResponsible = !isUnassigned;
  const assignmentStart = lead.assigned_at ? new Date(lead.assigned_at) : createdAt;
  const managerDeadline = hasResponsible ? calculateSalesSlaDeadline(assignmentStart, SLA_FIRST_CONTACT_MINUTES) : null;

  // Contact signals
  const firstContactAt = lead.first_contact_at ? new Date(lead.first_contact_at) : null;
  const isStatusMoved = lead.status && lead.status !== 'NEW';
  const hasCompletedTask = Boolean(lead.tasks && lead.tasks.some(t => t.status === 'COMPLETED'));
  const hasNotes = Boolean(lead.lead_notes && lead.lead_notes.length > 0);
  const hasDeals = Boolean(lead.deals && lead.deals.length > 0);

  const contactMade = Boolean(firstContactAt || isStatusMoved || hasCompletedTask || hasNotes || hasDeals);
  const contactTimestamp = firstContactAt || (contactMade ? (lead.updated_at ? new Date(lead.updated_at) : now) : null);

  const managerEnd = contactMade ? (contactTimestamp || now) : now;
  const managerWorkingMinutes = hasResponsible ? calculateSalesWorkingMinutes(assignmentStart, managerEnd) : 0;

  let managerStatus = 'NOT_APPLICABLE';
  if (hasResponsible) {
    if (contactMade) {
      managerStatus = managerWorkingMinutes <= SLA_FIRST_CONTACT_MINUTES ? 'CONTACT_COMPLETED_IN_TIME' : 'CONTACT_COMPLETED_OVERDUE';
    } else {
      if (managerWorkingMinutes > SLA_FIRST_CONTACT_MINUTES) {
        managerStatus = 'CONTACT_OVERDUE';
      } else if (managerWorkingMinutes >= SLA_WARNING_THRESHOLD_MINUTES) {
        managerStatus = 'CONTACT_WARNING';
      } else {
        managerStatus = 'CONTACT_ON_TRACK';
      }
    }
  }

  // 3. OVERALL STATUS & BADGE
  let overallStatus = 'ON_TRACK';
  let badge = { label: 'В графике', color: 'emerald', level: 'NORMAL' };

  if (isUnassigned) {
    overallStatus = 'UNASSIGNED';
    if (poolWorkingMinutes > SLA_FIRST_CONTACT_MINUTES) {
      badge = {
        label: `В пуле (>15м): просрочено ${poolWorkingMinutes - SLA_FIRST_CONTACT_MINUTES} мин`,
        color: 'rose',
        level: 'CRITICAL'
      };
    } else {
      badge = {
        label: `В пуле: ${SLA_FIRST_CONTACT_MINUTES - poolWorkingMinutes} мин до назначения`,
        color: 'blue',
        level: 'NORMAL'
      };
    }
  } else if (!contactMade) {
    if (managerWorkingMinutes > SLA_FIRST_CONTACT_MINUTES) {
      overallStatus = 'OVERDUE_CONTACT';
      badge = {
        label: `Просрочен контакт (+${managerWorkingMinutes - SLA_FIRST_CONTACT_MINUTES} мин)`,
        color: 'rose',
        level: 'CRITICAL'
      };
    } else if (managerWorkingMinutes >= SLA_WARNING_THRESHOLD_MINUTES) {
      overallStatus = 'WARNING_CONTACT';
      badge = {
        label: `Осталось ${SLA_FIRST_CONTACT_MINUTES - managerWorkingMinutes} мин`,
        color: 'amber',
        level: 'WARNING'
      };
    } else {
      overallStatus = 'NEW_IN_TIME';
      badge = {
        label: `Новый (${SLA_FIRST_CONTACT_MINUTES - managerWorkingMinutes} мин до SLA)`,
        color: 'blue',
        level: 'NORMAL'
      };
    }
  } else {
    overallStatus = 'ON_TRACK';
    badge = { label: 'Контакт выполнен', color: 'emerald', level: 'NORMAL' };
  }

  return {
    is_unassigned: isUnassigned,
    pool_sla: {
      status: poolStatus,
      working_minutes_elapsed: poolWorkingMinutes,
      deadline_at: poolDeadline ? poolDeadline.toISOString() : null,
      is_overdue: isUnassigned && poolWorkingMinutes > SLA_FIRST_CONTACT_MINUTES,
      overdue_minutes: Math.max(0, poolWorkingMinutes - SLA_FIRST_CONTACT_MINUTES),
      remaining_minutes: Math.max(0, SLA_FIRST_CONTACT_MINUTES - poolWorkingMinutes)
    },
    manager_sla: {
      applies: hasResponsible,
      status: managerStatus,
      contact_made: contactMade,
      first_contact_at: firstContactAt ? firstContactAt.toISOString() : null,
      working_minutes_elapsed: managerWorkingMinutes,
      deadline_at: managerDeadline ? managerDeadline.toISOString() : null,
      is_overdue: hasResponsible && !contactMade && managerWorkingMinutes > SLA_FIRST_CONTACT_MINUTES,
      overdue_minutes: Math.max(0, managerWorkingMinutes - SLA_FIRST_CONTACT_MINUTES),
      remaining_minutes: Math.max(0, SLA_FIRST_CONTACT_MINUTES - managerWorkingMinutes)
    },
    overall_status: overallStatus,
    badge
  };
}
