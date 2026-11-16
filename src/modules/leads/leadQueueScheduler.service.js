import { randomUUID } from 'node:crypto';
import { getServiceDB } from '../../db/connection.js';
import { RoundRobinService } from './roundRobin.service.js';
import { DistributionSettingsService } from './distributionSettings.service.js';
import { LeadsRepository } from './leads.repository.js';

/**
 * Invoke from a single scheduled job. Both opt-ins are required:
 * LEAD_QUEUE_SCHEDULER_ENABLED=true and database control.enabled=true.
 * PostgreSQL lease protects multiple instances; atomic lead RPC protects owners.
 */
export async function processScheduledLeadQueue({ db = getServiceDB(), limit = 10 } = {}) {
  if (process.env.LEAD_QUEUE_SCHEDULER_ENABLED !== 'true') {
    return { status: 'DISABLED', processed: 0, assigned: 0 };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Invalid batch limit');

  const settings = await DistributionSettingsService.getSettings({ forceFresh: true });
  if (settings.state !== 'SUCCESS' || settings.enabled !== true) {
    return { status: 'DISTRIBUTION_DISABLED', processed: 0, assigned: 0 };
  }

  const token = randomUUID();
  const { data: cutoff, error: claimError } = await db.rpc('claim_lead_queue_scheduler', {
    p_token: token, p_lease_seconds: 300
  });
  if (claimError) throw claimError;
  if (!cutoff) return { status: 'NOT_ENABLED_OR_BUSY', processed: 0, assigned: 0 };

  const result = { status: 'COMPLETED', processed: 0, assigned: 0, errors: 0 };
  try {
    const { data: leads, error } = await db.from('leads')
      .select('id,created_at,status,responsible_user_id')
      .is('archived_at', null)
      .is('responsible_user_id', null)
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
      .gte('created_at', new Date(cutoff).toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    for (const lead of leads || []) {
      // Revalidate on every iteration; a disabled switch takes effect mid-batch.
      const currentSettings = await DistributionSettingsService.getSettings({ forceFresh: true });
      if (currentSettings.state !== 'SUCCESS' || currentSettings.enabled !== true) {
        result.status = 'STOPPED';
        break;
      }
      const current = await LeadsRepository.findById(lead.id);
      if (!current || current.responsible_user_id ||
          !['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(current.status)) continue;
      const selection = await RoundRobinService.resolveAssignment(null, current.responsible_user_id);
      try {
        if (!selection.responsible_user_id) {
          result.status = 'NO_ELIGIBLE_MANAGER';
          break;
        }
        const updated = await LeadsRepository.assignManager(
          lead.id, selection.responsible_user_id, 'Планировщик новых заявок', null, false, true
        );
        result.processed += 1;
        if (Number(updated?.responsible_user_id) === Number(selection.responsible_user_id)) {
          result.assigned += 1;
        }
      } catch (err) {
        result.errors += 1;
        console.warn('[lead-queue-scheduler] assignment failed', { leadId: lead.id, message: err?.message });
      } finally {
        selection.releaseSlot?.();
      }
    }
    return result;
  } finally {
    const { error } = await db.rpc('release_lead_queue_scheduler', { p_token: token });
    if (error) console.error('[lead-queue-scheduler] lease release failed', error.message);
  }
}
