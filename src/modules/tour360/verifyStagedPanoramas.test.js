import { describe, expect, it, vi } from 'vitest';
import { verifyStagedPanoramas } from './verifyStagedPanoramas.js';
const path = 'projects/3/360/8/a.jpg';
const job = { id: 'j1', tour_id: 8, project_id: 3, state: 'VERIFYING', copied_paths: [path], manifest: { tour_id: 8, project_id: 3, destination_bucket: 'panoramas-360', files: [{ destination_path: path }] } };

describe('staged panorama integrity preflight', () => {
  it('passes nonzero object size without modifying files', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ name: 'a.jpg', metadata: { size: 1234 } }], error: null });
    const result = await verifyStagedPanoramas({ journal: { get: async () => job }, storage: { from: () => ({ list }) }, jobId: 'j1' });
    expect(result.verified).toBe(true);
    expect(result.activated).toBe(false);
  });
  it('fails closed on empty or missing object', async () => {
    const result = await verifyStagedPanoramas({ journal: { get: async () => job }, storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }, jobId: 'j1' });
    expect(result.verified).toBe(false);
  });
  it('rejects unjournaled path without storage access', async () => {
    const from = vi.fn();
    await expect(verifyStagedPanoramas({ journal: { get: async () => ({ ...job, copied_paths: [] }) }, storage: { from }, jobId: 'j1' })).rejects.toThrow('PUBLISH_FILE_NOT_JOURNALED');
    expect(from).not.toHaveBeenCalled();
  });
});
