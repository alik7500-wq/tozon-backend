import { describe, expect, it, vi } from 'vitest';
import { stageDraftWithJournal } from './stageDraftWithJournal.js';

const manifest = { tour_id: 8, project_id: 3, ready_for_publish: true, source_bucket: 'panoramas-360-drafts', destination_bucket: 'panoramas-360', files: [{ source_path: 'projects/3/360/8/a.jpg', destination_path: 'projects/3/360/8/a.jpg' }] };

describe('journaled panorama staging', () => {
  it('records staged paths and stops before activation', async () => {
    const transitions = [];
    const journal = { start: async () => ({ id: 'job-1' }), transition: async (...args) => { transitions.push(args); } };
    const storage = { from: name => name === 'panoramas-360-drafts'
      ? { download: async () => ({ data: new Blob(['x']), error: null }) }
      : { list: async () => ({ data: [], error: null }), upload: async () => ({ error: null }) } };
    const result = await stageDraftWithJournal({ journal, storage, manifest });
    expect(result.activated).toBe(false);
    expect(result.needs_verification).toBe(true);
    expect(transitions.map(t => t[2])).toEqual(['COPYING', 'VERIFYING']);
    expect(transitions[1][3].copied_paths).toHaveLength(1);
  });

  it('records failed staging without activation', async () => {
    const transitions = [];
    const journal = { start: async () => ({ id: 'job-2' }), transition: async (...args) => { transitions.push(args); } };
    const storage = { from: name => name === 'panoramas-360-drafts'
      ? { download: async () => ({ data: null, error: new Error('download') }) }
      : { list: async () => ({ data: [], error: null }) } };
    await expect(stageDraftWithJournal({ journal, storage, manifest })).rejects.toThrow('PANORAMA_DOWNLOAD_FAILED');
    expect(transitions.map(t => t[2])).toEqual(['COPYING', 'FAILED']);
  });
});
