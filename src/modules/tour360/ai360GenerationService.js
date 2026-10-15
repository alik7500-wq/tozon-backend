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


function getWebpDimensions(bytes) {
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) return {
    width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3)
  };
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
    width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff
  };
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function getJpegDimensions(bytes) {
  let pos = 2;
  while (pos + 4 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { height: bytes.readUInt16BE(pos + 3), width: bytes.readUInt16BE(pos + 5) };
    }
    pos += length;
  }
  return null;
}

export function validatePanoramaDimensions(bytes, mimeType) {
  const dimensions = mimeType === 'image/webp' ? getWebpDimensions(bytes) : getJpegDimensions(bytes);
  if (!dimensions || dimensions.width < 2048 || dimensions.height < 1024 ||
      dimensions.width !== dimensions.height * 2) {
    throw new Error('AI output must be a valid 2:1 panorama at least 2048x1024');
  }
  return dimensions;
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
  const dimensions = validatePanoramaDimensions(image.bytes, image.mimeType);
  const safeRoom = REQUIRED_360_ROOMS.indexOf(room) + 1;
  const randomId = randomUUID();
  const storagePath = `projects/${Number(projectId)}/360/${Number(tour.id)}/ai_${safeRoom}_${randomId}.${image.extension}`;
  const result = await draftStorage.upload({ path: storagePath, bytes: image.bytes, contentType: image.mimeType, upsert: false });
  if (!result || result.ok !== true) throw new Error('Private draft upload failed');
  return { room, storage_path: storagePath, mimeType: image.mimeType, bytes: image.bytes.length, width: dimensions.width, height: dimensions.height, status: 'DRAFT_UPLOADED_NOT_PUBLISHED', requiresProjectionValidation: true };
}
