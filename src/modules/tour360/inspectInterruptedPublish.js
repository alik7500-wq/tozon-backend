/**
 * Read-only crash recovery assessment for a publication job.
 * Does not delete/copy files or modify tour/job state.
 */
export async function inspectInterruptedPublish({ journal, storage, jobId }) {
  const job = await journal.get(jobId);
  if (!['PREPARING', 'COPYING', 'VERIFYING', 'ACTIVATING', 'NEEDS_RECOVERY'].includes(job.state)) {
    return { job_id: jobId, state: job.state, action: 'NONE', files: [] };
  }
  const manifest = job.manifest;
  if (!manifest || manifest.tour_id !== job.tour_id || manifest.project_id !== job.project_id || manifest.destination_bucket !== 'panoramas-360' || !Array.isArray(manifest.files)) {
    throw new Error('RECOVERY_MANIFEST_INVALID');
  }
  const files = [];
  for (const entry of manifest.files) {
    const path = entry?.destination_path;
    const prefix = `projects/${job.project_id}/360/${job.tour_id}/`;
    if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..')) throw new Error('RECOVERY_PATH_INVALID');
    const lastSlash = path.lastIndexOf('/');
    const folder = path.slice(0, lastSlash);
    const filename = path.slice(lastSlash + 1);
    const { data, error } = await storage.from('panoramas-360').list(folder, { search: filename, limit: 100 });
    if (error) throw new Error('RECOVERY_STORAGE_UNAVAILABLE');
    const object = (data || []).find(item => item.name === filename);
    files.push({ path, exists: Boolean(object), ownership_verified: false });
  }
  return {
    job_id: jobId, state: job.state, action: 'MANUAL_REVIEW_REQUIRED',
    files, automatic_deletion_allowed: false, automatic_activation_allowed: false
  };
}
