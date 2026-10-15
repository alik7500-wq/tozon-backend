import { describe, it, expect, vi } from 'vitest';
import { stagePanoramaCopies } from './panoramaCopyStaging.js';

const manifest = { tour_id: 8, project_id: 3, ready_for_publish: true, source_bucket: 'panoramas-360-drafts', destination_bucket: 'panoramas-360', files: [
  { source_path: 'projects/3/360/8/a.jpg', destination_path: 'projects/3/360/8/a.jpg' },
  { source_path: 'projects/3/360/8/b.jpg', destination_path: 'projects/3/360/8/b.jpg' }
] };

describe('panorama copy staging', () => {
  it('copies all files without activating tour', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const download = vi.fn().mockResolvedValue({ data: new Blob(['x'], { type: 'image/jpeg' }), error: null });
    const storage = { from: name => name === 'panoramas-360-drafts' ? { download } : { upload, list: async () => ({ data: [], error: null }) } };
    const result = await stagePanoramaCopies(storage, manifest);
    expect(result.staged).toBe(true);
    expect(result.copied_paths).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('rolls back first copied object if second upload fails', async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: new Error('network') });
    const remove = vi.fn().mockResolvedValue({ error: null });
    let operationId;
    const storage = { from: name => name === 'panoramas-360-drafts' ? { download: async () => ({ data: new Blob(['x']), error: null }) } : { upload: async (...args) => { operationId = args[2]?.metadata?.tour360_operation_id; return upload(...args); }, remove, list: async () => ({ data: operationId ? [{ name: 'a.jpg', metadata: { tour360_operation_id: operationId } }] : [], error: null }) } };
    await expect(stagePanoramaCopies(storage, manifest)).rejects.toThrow('PANORAMA_UPLOAD_FAILED');
    expect(remove).toHaveBeenCalledWith(['projects/3/360/8/a.jpg']);
  });

  it('fails closed when rollback fails', async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: new Error('network') });
    const storage = { from: name => name === 'panoramas-360-drafts' ? { download: async () => ({ data: new Blob(['x']), error: null }) } : { upload, list: async () => ({ data: [], error: null }), remove: async () => ({ error: new Error('denied') }) } };
    await expect(stagePanoramaCopies(storage, manifest)).rejects.toThrow('PANORAMA_ROLLBACK_INCOMPLETE');
  });

  it('rejects preflight failures without touching storage', async () => {
    const from = vi.fn();
    await expect(stagePanoramaCopies({ from }, { ...manifest, ready_for_publish: false })).rejects.toThrow('PUBLISH_PREFLIGHT_NOT_READY');
    expect(from).not.toHaveBeenCalled();
  });
});
