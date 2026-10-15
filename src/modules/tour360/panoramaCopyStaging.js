/**
 * Copy panorama files between buckets without mutating database state.
 * This helper is deliberately not wired to an HTTP route until a publish lock,
 * recovery journal, ownership checks and production integration tests exist.
 */
export async function stagePanoramaCopies(storage, manifest) {
  if (!manifest?.ready_for_publish || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('PUBLISH_PREFLIGHT_NOT_READY');
  }
  if (manifest.source_bucket !== 'panoramas-360-drafts' || manifest.destination_bucket !== 'panoramas-360' || !Number.isSafeInteger(Number(manifest.tour_id)) || Number(manifest.tour_id) <= 0 || !Number.isSafeInteger(Number(manifest.project_id)) || Number(manifest.project_id) <= 0) {
    throw new Error('INVALID_PUBLISH_MANIFEST');
  }
  const expectedPrefix = `projects/${manifest.project_id}/360/${manifest.tour_id}/`;
  for (const entry of manifest.files) {
    if (typeof entry?.source_path !== 'string' || entry.source_path !== entry.destination_path || !entry.source_path.startsWith(expectedPrefix) || entry.source_path.includes('..')) {
      throw new Error('INVALID_PANORAMA_STORAGE_PATH');
    }
  }
  const copied = [];
  const operationId = globalThis.crypto?.randomUUID?.();
  if (!operationId) throw new Error('PUBLISH_OPERATION_ID_REQUIRED');
  const seen = new Set();
  try {
    for (const entry of manifest.files) {
      const src = entry?.source_path;
      const dest = entry?.destination_path;
      if (typeof src !== 'string' || typeof dest !== 'string' || !src.startsWith('projects/') || !dest.startsWith('projects/') || src.includes('..') || dest.includes('..')) {
        throw new Error('INVALID_PANORAMA_STORAGE_PATH');
      }
      if (seen.has(dest)) throw new Error('DUPLICATE_DESTINATION_PATH');
      seen.add(dest);
      const { data: blob, error: downloadError } = await storage.from(manifest.source_bucket).download(src);
      if (downloadError || !blob) throw new Error('PANORAMA_DOWNLOAD_FAILED');
      const { data: existing, error: existingError } = await storage.from(manifest.destination_bucket).list(dest.slice(0, dest.lastIndexOf('/')), { search: dest.slice(dest.lastIndexOf('/') + 1), limit: 100 });
      if (existingError) throw new Error('DESTINATION_CHECK_FAILED');
      if ((existing || []).some(item => item.name === dest.slice(dest.lastIndexOf('/') + 1))) throw new Error('DESTINATION_ALREADY_EXISTS');
      const { error: uploadError } = await storage.from(manifest.destination_bucket).upload(dest, blob, { upsert: false, contentType: blob.type || 'image/jpeg', metadata: { tour360_operation_id: operationId } });
      if (uploadError) throw new Error('PANORAMA_UPLOAD_FAILED');
      copied.push(dest);
    }
    return { staged: true, copied_paths: copied };
  } catch (error) {
    const rollbackErrors = [];
    for (const dest of [...copied].reverse()) {
      const folder = dest.slice(0, dest.lastIndexOf('/'));
      const filename = dest.slice(dest.lastIndexOf('/') + 1);
      const { data: candidates, error: lookupError } = await storage.from(manifest.destination_bucket).list(folder, { search: filename, limit: 100 });
      const current = (candidates || []).find(item => item.name === filename);
      // Never delete an object whose ownership cannot be verified.
      if (lookupError || current?.metadata?.tour360_operation_id !== operationId) {
        rollbackErrors.push(dest);
        continue;
      }
      const { error: removeError } = await storage.from(manifest.destination_bucket).remove([dest]);
      if (removeError) rollbackErrors.push(dest);
    }
    if (rollbackErrors.length) {
      const failure = new Error('PANORAMA_ROLLBACK_INCOMPLETE');
      failure.cause = error;
      failure.remaining_paths = rollbackErrors;
      throw failure;
    }
    throw error;
  }
}
