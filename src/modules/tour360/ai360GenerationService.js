import { randomUUID } from 'node:crypto';
import { buildAi360SceneBrief, REQUIRED_360_ROOMS } from './ai360SceneBrief.js';

/** Provider adapter: generate({prompt, negativePrompt, references, width, height, projection})
 * must return { bytes: Buffer|Uint8Array, mimeType: 'image/jpeg'|'image/webp' }.
 * This module does NOT call an external provider or write to production.
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAGIC_JPEG = bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const MAGIC_WEBP = bytes => bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';

export function validateAi360Image(image) {
  if (!image || !image.bytes) throw new Error('AI provider returned no image');
  const bytes = Buffer.from(image.bytes);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('AI image size is invalid');
  if (image.mimeType === 'image/jpeg' && MAGIC_JPEG(bytes)) return { bytes, mimeType: image.mimeType, extension: 'jpg' };
  if (image.mimeType === 'image/webp' && MAGIC_WEBP(bytes)) return { bytes, mimeType: image.mimeType, extension: 'webp' };
  throw new Error('AI image MIME type or file signature is invalid');
}

/**
 * Controlled pilot generation. Explicit provider and private storage adapters are required.
 * Caller must independently verify real image dimensions and projection before publication.
 * No published-tour mutation or implicit activation occurs here.
 */
export async function generateAi360PilotDraft({ provider, draftStorage, tour, projectId, room, layoutCode }) {
  if (!provider || typeof provider.generate !== 'function') throw new Error('AI provider not configured');
  if (!draftStorage || typeof draftStorage.upload !== 'function') throw new Error('Private draft storage not configured');
  if (!tour || tour.is_active !== false || !Number.isSafeInteger(Number(tour.id))) throw new Error('An inactive draft tour is required');
  if (!Number.isSafeInteger(Number(projectId)) || Number(projectId) !== Number(tour.project_id)) throw new Error('Tour/project mismatch');
  if (!REQUIRED_360_ROOMS.includes(room)) throw new Error('Unsupported room');
  const brief = buildAi360SceneBrief(room, { layoutCode });
  const image = validateAi360Image(await provider.generate({
    prompt: brief.prompt,
    negativePrompt: brief.negativePrompt,
    references: brief.references,
    width: brief.targetWidth,
    height: brief.targetHeight,
    projection: brief.projection
  }));
  const safeRoom = REQUIRED_360_ROOMS.indexOf(room) + 1;
  const randomId = randomUUID();
  const storagePath = `projects/${Number(projectId)}/360/${Number(tour.id)}/ai_${safeRoom}_${randomId}.${image.extension}`;
  const result = await draftStorage.upload({ path: storagePath, bytes: image.bytes, contentType: image.mimeType, upsert: false });
  if (!result || result.ok !== true) throw new Error('Private draft upload failed');
  return { room, storage_path: storagePath, mimeType: image.mimeType, bytes: image.bytes.length, status: 'DRAFT_UPLOADED_NOT_PUBLISHED', requiresProjectionValidation: true };
}
