/**
 * Activation precondition only. No database writes or public API routes.
 * A separate transaction must re-check state before setting tours_360.is_active.
 */
export function assertTour360ActivationReady({ job, gate, tour }) {
  if (!job || !gate || !tour) throw new Error('ACTIVATION_CONTEXT_MISSING');
  if (job.state !== 'VERIFYING' || gate.job_id !== job.id || gate.ready !== true || gate.activated !== false) {
    throw new Error('ACTIVATION_GATE_NOT_PASSED');
  }
  if (job.tour_id !== tour.id || job.project_id !== tour.project_id || tour.is_active !== false) {
    throw new Error('ACTIVATION_TOUR_MISMATCH');
  }
  if (!Array.isArray(gate.checksums?.files) || !gate.checksums.files.length || !gate.checksums.files.every(file => file.matches === true)) {
    throw new Error('ACTIVATION_CHECKSUMS_UNVERIFIED');
  }
  if (!Array.isArray(gate.existence?.files) || gate.existence.files.length !== gate.checksums.files.length || !gate.existence.files.every(file => file.exists === true && file.size > 0)) {
    throw new Error('ACTIVATION_FILES_UNVERIFIED');
  }
  return { tour_id: tour.id, job_id: job.id, can_prepare_activation: true, activated: false };
}
