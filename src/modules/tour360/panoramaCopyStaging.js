/**
 * Copy panorama files between buckets without mutating database state.
 * This helper is deliberately not wired to an HTTP route until a publish lock,
 * recovery journal, ownership checks and production integration tests exist.
 */
export async function stagePanoramaCopies(storage, manifest) {
  if (!manifest?.ready_for_publish || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('PUBLISH_PREFLIGHT_NOT_READY');
  }
  const copied = [];
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
      const { error: uploadError } = await storage.from(manifest.destination_bucket).upload(dest, blob, { upsert: false, contentType: blob.type || 'image/jpeg' });
      if (uploadError) throw new Error('PANORAMA_UPLOAD_FAILED');
      copied.push(dest);
    }
    return { staged: true, copied_paths: copied };
  } catch (error) {
    const rollbackErrors = [];
    for (const dest of [...copied].reverse()) {
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
