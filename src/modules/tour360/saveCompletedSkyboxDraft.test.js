import { describe, expect, it, vi } from 'vitest';
import { saveCompletedSkyboxDraft } from './saveCompletedSkyboxDraft.js';

const tour = { id: 7, project_id: 3, is_active: false };
const image = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,8,0,8,0,3,1,17,0,2,17,0,3,17,0,0xff,0xd9]);
const args = { job: { id: 17, status: 'complete', file_url: 'https://cdn.blockadelabs.com/render.jpg' }, projectId: 3, tour, room: 'Гостиная' };
describe('Skybox private panorama import', () => {
  it('rejects untrusted provider URLs without downloading', async () => {
    const download = vi.fn();
    await expect(saveCompletedSkyboxDraft({ ...args, job: { ...args.job, file_url: 'https://blockadelabs.com.attacker.test/a.jpg' }, download, privateStorage: { upload: vi.fn() } })).rejects.toThrow('Untrusted Skybox image host');
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects non-equirectangular geometry before uploading', async () => {
    const upload = vi.fn();
    await expect(saveCompletedSkyboxDraft({ ...args, download: vi.fn().mockResolvedValue({ bytes: image, mimeType: 'image/jpeg' }), privateStorage: { upload } })).rejects.toThrow('2:1 panorama');
    expect(upload).not.toHaveBeenCalled();
  });
});
