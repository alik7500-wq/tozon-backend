import { createSkyboxApiClient } from './skyboxApiClient.js';
import { buildAi360SceneBrief, REQUIRED_360_ROOMS, PILOT_LAYOUT } from './ai360SceneBrief.js';
import { Tour360Repository } from './tour360.repository.js';

export function skyboxStatus(env = process.env) {
  return { provider: 'skybox', configured: Boolean(env.SKYBOX_API_KEY), generationEnabled: env.SKYBOX_GENERATION_ENABLED === 'true', requiresExplicitApproval: true, autoPublish: false };
}
export function getSkyboxClient() {
  if (!process.env.SKYBOX_API_KEY) throw new Error('Skybox API key is not configured');
  return createSkyboxApiClient({ apiKey: process.env.SKYBOX_API_KEY });
}
export async function startSkyboxRoomGeneration({ projectId, tourId, room, styleId, approved, client = getSkyboxClient(), env = process.env }) {
  if (env.SKYBOX_GENERATION_ENABLED !== 'true') throw new Error('Skybox generation is disabled');
  if (approved !== true) throw new Error('Explicit credit-spending approval is required');
  if (Number(projectId) !== PILOT_LAYOUT.projectId || !REQUIRED_360_ROOMS.includes(room)) throw new Error('Unsupported pilot project or room');
  if (!Number.isSafeInteger(styleId) || styleId < 1) throw new Error('Valid Skybox style ID required');
  const visibility = await Tour360Repository.getTourVisibility(tourId);
  if (!visibility || visibility.is_active || Number(visibility.project_id) !== Number(projectId)) throw new Error('Matching inactive tour required');
  const brief = buildAi360SceneBrief(room);
  const result = await client.createGeneration({ styleId, prompt: brief.prompt, negativeText: brief.negativePrompt });
  return { provider: 'skybox', jobId: result.id, status: result.status, room, tourId: Number(tourId), projectId: Number(projectId), published: false, note: 'Provider job only; download, geometry review and private upload are separate steps.' };
}
