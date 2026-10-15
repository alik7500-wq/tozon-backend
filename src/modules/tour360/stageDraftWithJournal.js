import { stagePanoramaCopies } from './panoramaCopyStaging.js';

/** Internal-only staging. No HTTP route and no tour activation. */
export async function stageDraftWithJournal({ journal, storage, manifest }) {
  if (!manifest?.ready_for_publish || !manifest.project_id || !manifest.tour_id) {
    throw new Error('PUBLISH_PREFLIGHT_NOT_READY');
  }
  const job = await journal.start({ tourId: manifest.tour_id, projectId: manifest.project_id, manifest });
  await journal.transition(job.id, 'PREPARING', 'COPYING');
  let result;
  try {
    result = await stagePanoramaCopies(storage, manifest);
  } catch (error) {
    const needsRecovery = error.message === 'PANORAMA_ROLLBACK_INCOMPLETE';
    try {
      await journal.transition(job.id, 'COPYING', needsRecovery ? 'NEEDS_RECOVERY' : 'FAILED', { error_code: error.message });
    } catch (journalError) {
      const failure = new Error('PUBLISH_JOURNAL_UPDATE_FAILED');
      failure.cause = { operation: error, journal: journalError };
      throw failure;
    }
    throw error;
  }
  // Files already exist. If the journal write fails, NEVER mark FAILED:
  // recovery must inspect destinations before any retry or deletion.
  try {
    await journal.transition(job.id, 'COPYING', 'VERIFYING', { copied_paths: result.copied_paths });
  } catch (error) {
    try {
      await journal.transition(job.id, 'COPYING', 'NEEDS_RECOVERY', {
        copied_paths: result.copied_paths,
        error_code: 'PUBLISH_JOURNAL_VERIFY_TRANSITION_FAILED'
      });
    } catch (journalError) {
      const failure = new Error('PUBLISH_JOURNAL_UPDATE_FAILED');
      failure.cause = { operation: error, journal: journalError, copied_paths: result.copied_paths };
      throw failure;
    }
    const failure = new Error('PUBLISH_NEEDS_RECOVERY');
    failure.cause = error;
    failure.copied_paths = result.copied_paths;
    throw failure;
  }
  return { job_id: job.id, copied_paths: result.copied_paths, activated: false, needs_verification: true };
}
