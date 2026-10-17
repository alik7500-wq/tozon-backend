import { verifyStagedPanoramas } from './verifyStagedPanoramas.js';
import { verifyPanoramaChecksums } from './verifyPanoramaChecksums.js';

/** Read-only final gate. Never activates a tour or advances journal state. */
export async function evaluateTour360PublishGate({ journal, storage, jobId }) {
  const job = await journal.get(jobId);
  if (job.state !== 'VERIFYING') throw new Error('PUBLISH_GATE_INVALID_STATE');
  const existence = await verifyStagedPanoramas({ journal: { get: async () => job }, storage, jobId });
  if (!existence.verified) return { job_id: jobId, ready: false, reason: 'MISSING_OR_EMPTY_FILES', activated: false, existence };
  const checksums = await verifyPanoramaChecksums({ storage, manifest: job.manifest });
  return {
    job_id: jobId, ready: checksums.verified,
    reason: checksums.verified ? null : 'CHECKSUM_MISMATCH',
    activated: false, existence, checksums
  };
}
