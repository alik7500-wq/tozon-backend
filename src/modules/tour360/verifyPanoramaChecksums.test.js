import { describe, expect, it } from 'vitest';
import { verifyPanoramaChecksums } from './verifyPanoramaChecksums.js';
const manifest = { ready_for_publish: true, project_id: 3, tour_id: 8, source_bucket: 'panoramas-360-drafts', destination_bucket: 'panoramas-360', files: [{ source_path: 'projects/3/360/8/a.jpg', destination_path: 'projects/3/360/8/a.jpg' }] };
const blob = content => new Blob([content]);

describe('360 panorama SHA-256 verification', () => {
  it('accepts matching source and destination content', async () => {
    const storage = { from: () => ({ download: async () => ({ data: blob('identical'), error: null }) }) };
    const result = await verifyPanoramaChecksums({ storage, manifest });
    expect(result.verified).toBe(true);
    expect(result.files[0].source_sha256).toBe(result.files[0].destination_sha256);
  });
  it('rejects changed content despite matching file size', async () => {
    const storage = { from: bucket => ({ download: async () => ({ data: blob(bucket === 'panoramas-360-drafts' ? 'abc' : 'xyz'), error: null }) }) };
    const result = await verifyPanoramaChecksums({ storage, manifest });
    expect(result.verified).toBe(false);
  });
  it('rejects invalid foreign project paths', async () => {
    const storage = { from: () => { throw new Error('should not be called'); } };
    await expect(verifyPanoramaChecksums({ storage, manifest: { ...manifest, files: [{ source_path: 'projects/4/360/8/a.jpg', destination_path: 'projects/4/360/8/a.jpg' }] } })).rejects.toThrow('CHECKSUM_PATH_INVALID');
  });
});
