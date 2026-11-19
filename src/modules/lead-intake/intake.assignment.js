import { RoundRobinService } from '../leads/roundRobin.service.js';
import { LeadsRepository } from '../leads/leads.repository.js';

/**
 * Intake RPC has already committed the inquiry at this point.
 * Only CREATED records with no explicitly configured manager may be assigned.
 * Failures never turn a successfully received webhook into a retryable HTTP error.
 */
export async function assignNewIntakeLead(result, { hasExplicitManager = false } = {}) {
  if (result?.outcome !== 'CREATED' || !result.lead_id || hasExplicitManager) return false;

  let assignment;
  try {
    assignment = await RoundRobinService.resolveAssignment();
    if (!assignment?.responsible_user_id) return false;
    const updated = await LeadsRepository.assignManager(
      result.lead_id,
      assignment.responsible_user_id,
      assignment.reason,
      null,
      false,
      true
    );
    return Number(updated?.responsible_user_id) === Number(assignment.responsible_user_id);
  } catch (error) {
    console.warn('[lead-intake] Automatic assignment deferred; lead remains available in CRM:', error?.message);
    return false;
  } finally {
    assignment?.releaseSlot?.();
  }
}
