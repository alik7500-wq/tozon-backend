/**
 * Read-only verification of staged panorama files prior to any activation.
 * Requires a journal job in VERIFYING state. Does not mutate storage or DB.
 */
export async function verifyStagedPanoramas({ journal, storage, jobId }) {
  const job = await journal.get(jobId);
  if (job.state !== 'VERIFYING') throw new Error('PUBLISH_NOT_READY_FOR_VERIFICATION');
  const manifest = job.manifest;
  if (manifest?.project_id !== job.project_id || manifest?.tour_id !== job.tour_id || manifest?.destination_bucket !== 'panoramas-360' || !Array.isArray(manifest?.files) || !manifest.files.length) {
    throw new Error('PUBLISH_MANIFEST_INVALID');
  }
  const checked = [];
  const copied = new Set(job.copied_paths || []);
  for (const entry of manifest.files) {
    const path = entry?.destination_path;
    const prefix = `projects/${job.project_id}/360/${job.tour_id}/`;
    if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..') || !copied.has(path)) throw new Error('PUBLISH_FILE_NOT_JOURNALED');
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash);
    const filename = path.slice(slash + 1);
    const { data, error } = await storage.from('panoramas-360').list(folder, { search: filename, limit: 100 });
    if (error) throw new Error('PUBLISH_VERIFY_STORAGE_ERROR');
    const object = (data || []).find(item => item.name === filename);
    checked.push({ path, exists: Boolean(object), size: object?.metadata?.size ?? null });
  }
  return {
    job_id: jobId,
    verified: checked.length > 0 && checked.every(f => f.exists && typeof f.size === 'number' && f.size > 0),
    files: checked,
    activated: false,
    note: 'Read-only existence and nonzero-size check; no checksum verification or activation.'
  };
}
