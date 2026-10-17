import { describe, expect, it, vi } from 'vitest';
import { inspectInterruptedPublish } from './inspectInterruptedPublish.js';

const job = { id: 'j1', tour_id: 8, project_id: 3, state: 'COPYING', manifest: { tour_id: 8, project_id: 3, destination_bucket: 'panoramas-360', files: [{ destination_path: 'projects/3/360/8/a.jpg' }] } };

describe('interrupted 360 publication diagnostics', () => {
  it('inspects copied object without mutation', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ name: 'a.jpg' }], error: null });
    const storage = { from: () => ({ list }) };
    const result = await inspectInterruptedPublish({ journal: { get: async () => job }, storage, jobId: 'j1' });
    expect(result.action).toBe('MANUAL_REVIEW_REQUIRED');
    expect(result.files[0].exists).toBe(true);
    expect(result.automatic_deletion_allowed).toBe(false);
    expect(result.automatic_activation_allowed).toBe(false);
  });

  it('rejects foreign project paths before storage access', async () => {
    const from = vi.fn();
    const invalid = { ...job, manifest: { ...job.manifest, files: [{ destination_path: 'projects/4/360/8/a.jpg' }] } };
    await expect(inspectInterruptedPublish({ journal: { get: async () => invalid }, storage: { from }, jobId: 'j1' })).rejects.toThrow('RECOVERY_PATH_INVALID');
    expect(from).not.toHaveBeenCalled();
  });
});
