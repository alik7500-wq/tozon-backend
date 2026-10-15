import { describe, it, expect, vi } from 'vitest';
import { skyboxStatus, startSkyboxRoomGeneration } from './skyboxIntegration.js';
import { Tour360Repository } from './tour360.repository.js';

describe('Skybox generation safety', () => {
  it('never exposes API keys in status', () => {
    const result = skyboxStatus({ SKYBOX_API_KEY: 'secret', SKYBOX_GENERATION_ENABLED: 'true' });
    expect(result).toEqual({ provider: 'skybox', configured: true, generationEnabled: true, requiresExplicitApproval: true, autoPublish: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('does not spend credits without explicit approval', async () => {
    const client = { createGeneration: vi.fn() };
    await expect(startSkyboxRoomGeneration({ projectId: 3, tourId: 7, room: 'Гостиная', styleId: 5, approved: false, client, env: { SKYBOX_GENERATION_ENABLED: 'true' } })).rejects.toThrow('Explicit credit-spending approval');
    expect(client.createGeneration).not.toHaveBeenCalled();
  });
  it('does not spend credits when disabled', async () => {
    const client = { createGeneration: vi.fn() };
    await expect(startSkyboxRoomGeneration({ projectId: 3, tourId: 7, room: 'Гостиная', styleId: 5, approved: true, client, env: {} })).rejects.toThrow('disabled');
    expect(client.createGeneration).not.toHaveBeenCalled();
  });
  it('does not spend credits for published tours', async () => {
    const client = { createGeneration: vi.fn() };
    const spy = vi.spyOn(Tour360Repository, 'getTourVisibility').mockResolvedValue({ is_active: true, project_id: 3 });
    try {
      await expect(startSkyboxRoomGeneration({ projectId: 3, tourId: 7, room: 'Гостиная', styleId: 5, approved: true, client, env: { SKYBOX_GENERATION_ENABLED: 'true' } })).rejects.toThrow('Matching inactive tour');
      expect(client.createGeneration).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
