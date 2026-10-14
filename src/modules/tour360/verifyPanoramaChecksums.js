import { createHash } from 'node:crypto';

/** Read-only SHA-256 comparison of source and destination panorama objects. */
export async function verifyPanoramaChecksums({ storage, manifest }) {
  if (!manifest?.ready_for_publish || !manifest?.project_id || !manifest?.tour_id ||
      manifest.source_bucket !== 'panoramas-360-drafts' || manifest.destination_bucket !== 'panoramas-360' ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('CHECKSUM_MANIFEST_INVALID');
  const expectedPrefix = `projects/${manifest.project_id}/360/${manifest.tour_id}/`;
  const results = [];
  for (const file of manifest.files) {
    if (typeof file?.source_path !== 'string' || file.source_path !== file.destination_path || !file.source_path.startsWith(expectedPrefix) || file.source_path.includes('..')) {
      throw new Error('CHECKSUM_PATH_INVALID');
    }
    const hashes = [];
    for (const bucket of [manifest.source_bucket, manifest.destination_bucket]) {
      const { data, error } = await storage.from(bucket).download(file.source_path);
      if (error || !data) throw new Error('CHECKSUM_DOWNLOAD_FAILED');
      const buffer = Buffer.from(await data.arrayBuffer());
      if (!buffer.length) throw new Error('CHECKSUM_EMPTY_FILE');
      hashes.push(createHash('sha256').update(buffer).digest('hex'));
    }
    results.push({ path: file.source_path, source_sha256: hashes[0], destination_sha256: hashes[1], matches: hashes[0] === hashes[1] });
  }
  return { verified: results.every(r => r.matches), files: results, activated: false };
}
