import { describe, expect, it } from 'vitest';
import { evaluateTour360PublishGate } from './evaluateTour360PublishGate.js';
const path = 'projects/3/360/8/a.jpg';
const job = { id: 'j1', tour_id: 8, project_id: 3, state: 'VERIFYING', copied_paths: [path], manifest: { ready_for_publish: true, tour_id: 8, project_id: 3, source_bucket: 'panoramas-360-drafts', destination_bucket: 'panoramas-360', files: [{ source_path: path, destination_path: path }] } };
function storageFor(source, target, present = true) {
  return { from: bucket => ({
    list: async () => ({ data: present ? [{ name: 'a.jpg', metadata: { size: 3 } }] : [], error: null }),
    download: async () => ({ data: new Blob([bucket === 'panoramas-360-drafts' ? source : target]), error: null })
  }) };
}

describe('360 final publish gate', () => {
  it('passes matching objects without activating', async () => {
    const result = await evaluateTour360PublishGate({ journal: { get: async () => job }, storage: storageFor('abc', 'abc'), jobId: 'j1' });
    expect(result.ready).toBe(true);
    expect(result.activated).toBe(false);
  });
  it('blocks missing destination before hashing', async () => {
    const result = await evaluateTour360PublishGate({ journal: { get: async () => job }, storage: storageFor('abc', 'abc', false), jobId: 'j1' });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('MISSING_OR_EMPTY_FILES');
  });
  it('blocks checksum mismatch', async () => {
    const result = await evaluateTour360PublishGate({ journal: { get: async () => job }, storage: storageFor('abc', 'xyz'), jobId: 'j1' });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('CHECKSUM_MISMATCH');
  });
});
