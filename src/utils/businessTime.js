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
