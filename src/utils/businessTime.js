/**
 * TOZON CRM — Canonical Business Time Helper
 * Source of Truth Timezone: Asia/Dushanbe (UTC+5)
 */

export const BUSINESS_TIMEZONE = 'Asia/Dushanbe';

/**
 * Returns the current or provided business date string ('YYYY-MM-DD') in Asia/Dushanbe timezone.
 */
export function getBusinessDate(nowInput = null) {
  const date = nowInput ? new Date(nowInput) : new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const p = {};
  parts.forEach((item) => (p[item.type] = item.value));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Returns current or provided business date and time in Asia/Dushanbe timezone.
 * Returns { dateStr: 'YYYY-MM-DD', timeStr: 'HH:MM' }
 */
export function getBusinessDateTime(nowInput = null) {
  const date = nowInput ? new Date(nowInput) : new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const p = {};
  parts.forEach((item) => (p[item.type] = item.value));
  const hour = p.hour === '24' ? '00' : p.hour.padStart(2, '0');
  const minute = p.minute.padStart(2, '0');
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${hour}:${minute}`
  };
}

export const WORK_HOURS = {
  START: 8,  // 08:00 Asia/Dushanbe
  END: 20    // 20:00 Asia/Dushanbe
};

const DUSHANBE_OFFSET_MS = 5 * 3600 * 1000;

/**
 * Returns true if the given or current timestamp is within business hours (08:00–20:00 Asia/Dushanbe).
 */
export function isWithinWorkingHours(dateInput = null, options = {}) {
  const { skipWeekends = false, skipSunday = false } = options;
  const d = dateInput ? new Date(dateInput) : new Date();
  const local = new Date(d.getTime() + DUSHANBE_OFFSET_MS);
  const day = local.getUTCDay();
  if (skipWeekends && (day === 0 || day === 6)) return false;
  if (skipSunday && day === 0) return false;
  const hour = local.getUTCHours();
  return hour >= WORK_HOURS.START && hour < WORK_HOURS.END;
}

/**
 * Checks if current time in Asia/Dushanbe is within Sales Automation execution window:
 * 08:00 to 20:00 Asia/Dushanbe inclusive.
 * Allows buffer up to 20:05 (1205 min) for container spin-up of the 20:00 TJT run.
 * Strictly excludes 20:30 (1230 min / 15:30 UTC) or any other off-hours.
 */
export function isWithinSalesAutomationWindow(nowInput = null) {
  const bdt = getBusinessDateTime(nowInput);
  const [hStr, mStr] = bdt.timeStr.split(':');
  const timeInMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
  return timeInMinutes >= 480 && timeInMinutes <= 1205;
}

/**
 * Returns true if date falls on an active business day.
 */
export function isBusinessDay(dateInput = null, options = {}) {
  const { skipWeekends = false, skipSunday = false } = options;
  const d = dateInput ? new Date(dateInput) : new Date();
  const local = new Date(d.getTime() + DUSHANBE_OFFSET_MS);
  const day = local.getUTCDay();
  if (skipWeekends && (day === 0 || day === 6)) return false;
  if (skipSunday && day === 0) return false;
  return true;
}

/**
 * Calculates working minutes elapsed between startInput and endInput (defaults to now)
 * within the working hours window (08:00 - 20:00 Asia/Dushanbe).
 * Overnight and out-of-bounds time is excluded.
 * Options allow configuring weekend behavior (e.g. skipWeekends, skipSunday).
 */
export function calculateWorkingMinutes(startInput, endInput = null, options = {}) {
  if (!startInput) return 0;
  const start = new Date(startInput);
  const end = endInput ? new Date(endInput) : new Date();

  if (end <= start) return 0;

  let totalMinutes = 0;

  // Determine starting and ending dates in Dushanbe time
  const startLocal = new Date(start.getTime() + DUSHANBE_OFFSET_MS);
  const endLocal = new Date(end.getTime() + DUSHANBE_OFFSET_MS);

  // Iterate calendar days in Dushanbe time from start to end
  const currentDay = new Date(Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate()));
  const lastDay = new Date(Date.UTC(endLocal.getUTCFullYear(), endLocal.getUTCMonth(), endLocal.getUTCDate()));

  while (currentDay <= lastDay) {
    const y = currentDay.getUTCFullYear();
    const m = currentDay.getUTCMonth();
    const d = currentDay.getUTCDate();
    const dayOfWeek = currentDay.getUTCDay();

    const isWeekend = options.skipWeekends && (dayOfWeek === 0 || dayOfWeek === 6);
    const isSundayOff = options.skipSunday && dayOfWeek === 0;

    if (!isWeekend && !isSundayOff) {
      // 08:00 TJT on this day in UTC ms
      const dayStartUtcMs = Date.UTC(y, m, d, WORK_HOURS.START, 0, 0) - DUSHANBE_OFFSET_MS;
      // 20:00 TJT on this day in UTC ms
      const dayEndUtcMs = Date.UTC(y, m, d, WORK_HOURS.END, 0, 0) - DUSHANBE_OFFSET_MS;

      const windowStart = Math.max(start.getTime(), dayStartUtcMs);
      const windowEnd = Math.min(end.getTime(), dayEndUtcMs);

      if (windowEnd > windowStart) {
        totalMinutes += Math.floor((windowEnd - windowStart) / 60000);
      }
    }

    // Move to next day
    currentDay.setUTCDate(currentDay.getUTCDate() + 1);
  }

  return totalMinutes;
}

/**
 * Formats minutes into human-readable duration in Russian:
 * e.g. 15 -> "15 мин", 75 -> "1 ч 15 мин", 1500 -> "25 ч"
 */
export function formatWorkingDuration(minutes) {
  if (!minutes || minutes <= 0) return '0 мин';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins} мин`;
  if (mins === 0) return `${hrs} ч`;
  return `${hrs} ч ${mins} мин`;
}

