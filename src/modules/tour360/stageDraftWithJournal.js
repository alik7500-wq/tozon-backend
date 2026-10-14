import { stagePanoramaCopies } from './panoramaCopyStaging.js';

/**
 * Internal-only draft staging coordinator. NO HTTP ROUTE, NO ACTIVATION.
 * Requires preflight-verified manifest and an installed publish-journal table.
 * Do not call in production before crash-recovery design is completed.
 */
export async function stageDraftWithJournal({ journal, storage, manifest }) {
  if (!manifest?.ready_for_publish || !manifest.project_id || !manifest.tour_id) {
    throw new Error('PUBLISH_PREFLIGHT_NOT_READY');
  }
  const job = await journal.start({ tourId: manifest.tour_id, projectId: manifest.project_id, manifest });
  await journal.transition(job.id, 'PREPARING', 'COPYING');
  try {
    const result = await stagePanoramaCopies(storage, manifest);
    await journal.transition(job.id, 'COPYING', 'VERIFYING', { copied_paths: result.copied_paths });
    return { job_id: job.id, copied_paths: result.copied_paths, activated: false, needs_verification: true };
  } catch (error) {
    const needsRecovery = error.message === 'PANORAMA_ROLLBACK_INCOMPLETE';
    try {
      await journal.transition(job.id, 'COPYING', needsRecovery ? 'NEEDS_RECOVERY' : 'FAILED', {
        error_code: error.message
      });
    } catch (journalError) {
      const failure = new Error('PUBLISH_JOURNAL_UPDATE_FAILED');
      failure.cause = { operation: error, journal: journalError };
      throw failure;
    }
    throw error;
  }
}
