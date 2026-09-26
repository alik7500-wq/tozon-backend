import { getDB } from '../db/connection.js';
import { allocatePaymentsFIFO, getDushanbeCurrentDateStr } from './fifoPaymentAllocation.js';

const ALLOWED_PG_STATUSES = ['PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL'];

/**
 * Idempotently recalculates and updates stored DB deal_payment_schedules for a given dealId
 * @param {number} dealId
 * @param {string|null} customDateStr - Optional date string (YYYY-MM-DD)
 * @returns {Promise<Object|null>} FIFO Allocation result
 */
export async function recalculateDealSchedules(dealId, customDateStr = null) {
  const db = getDB();
  const today = customDateStr || getDushanbeCurrentDateStr();

  // 1. Fetch deal
  const { data: deal, error: dErr } = await db
    .from('deals')
    .select('id, contract_number, final_price_minor, down_payment_minor, status')
    .eq('id', dealId)
    .single();

  if (dErr || !deal) {
    throw new Error(`DEAL_NOT_FOUND: Deal ID ${dealId} could not be retrieved from DB`);
  }

  // 2. Fetch active payments
  const { data: payments, error: pErr } = await db
    .from('payments')
    .select('id, amount_minor, payment_date, status')
    .eq('deal_id', dealId)
    .neq('status', 'VOIDED')
    .order('payment_date');

  if (pErr) throw pErr;

  // 3. Fetch schedules
  const { data: schedules, error: sErr } = await db
    .from('deal_payment_schedules')
    .select('*')
    .eq('deal_id', dealId)
    .order('due_date');

  if (sErr || !schedules || schedules.length === 0) return null;

  // 4. Run FIFO allocation
  const fifoResult = allocatePaymentsFIFO(schedules, payments || [], deal.down_payment_minor || 0, today);

  // 5. Pre-validate and collect rows to update
  const updatesToApply = [];
  const now = new Date().toISOString();
  const existingScheduleIds = new Set(schedules.map(s => s.id));

  for (const item of fifoResult.schedules) {
    if (!existingScheduleIds.has(item.id)) {
      throw new Error(`INVALID_SCHEDULE_ID: Schedule ID ${item.id} does not exist in deal ${dealId}`);
    }

    const newPaid = item.paid_amount_minor;
    const newStatus = item.computed_status;

    if (!ALLOWED_PG_STATUSES.includes(newStatus)) {
      throw new Error(`INVALID_STATUS_FOR_DB: Status "${newStatus}" for row ID ${item.id} violates Postgres check constraint`);
    }

    const storedPaid = item.paid_amount_minor_db !== undefined ? item.paid_amount_minor_db : (item.paid_amount_minor_original || 0);
    const storedStatus = item.stored_status;

    if (storedStatus !== newStatus || newPaid !== storedPaid) {
      updatesToApply.push({
        ...item,
        paid_amount_minor: newPaid,
        status: newStatus,
        updated_at: now
      });
    }
  }

  // 6. Apply updates atomically in a single PostgreSQL batch upsert statement.
  if (updatesToApply.length > 0) {
    const { error: uErr } = await db
      .from('deal_payment_schedules')
      .upsert(updatesToApply, { onConflict: 'id' });

    if (uErr) {
      console.error(`ATOMIC_UPDATE_FAILURE: Deal ${dealId} batch update failed:`, uErr.message);
      throw new Error(`ATOMIC_UPDATE_FAILURE: Deal ${dealId} batch update failed: ${uErr.message}`);
    }
  }

  return fifoResult;
}

/**
 * Recalculates payment schedules for ALL deals in the database
 */
export async function recalculateAllDeals(customDateStr = null) {
  const db = getDB();
  const { data: deals, error } = await db.from('deals').select('id, contract_number');
  if (error || !deals) return { count: 0, results: [] };

  const results = [];
  for (const d of deals) {
    const res = await recalculateDealSchedules(d.id, customDateStr);
    if (res) {
      results.push({ dealId: d.id, contractNumber: d.contract_number, ...res });
    }
  }
  return { count: results.length, results };
}
