import { validateAi360Image } from './ai360GenerationService.js';

/** Downloads a completed Skybox render without trusting provider-supplied URLs.
 * An explicit private storage adapter must be injected. No publication occurs.
 * A human must verify spherical projection and fidelity to the floor plan.
 */
export async function saveCompletedSkyboxDraft({ job, projectId, tour, room, privateStorage, download, maxBytes = 25 * 1024 * 1024 }) {
  if (!job || !['complete', 'completed', 'success'].includes(String(job.status).toLowerCase())) throw new Error('Skybox job is not completed');
  if (!Number.isSafeInteger(Number(projectId)) || !tour || tour.is_active !== false || Number(tour.project_id) !== Number(projectId) || !Number.isSafeInteger(Number(tour.id))) throw new Error('Inactive matching tour required');
  if (typeof room !== 'string' || !['Гостиная', 'Спальня', 'Кухня', 'Санузел', 'Коридор'].includes(room)) throw new Error('Unknown room');
  if (!privateStorage || typeof privateStorage.upload !== 'function' || typeof download !== 'function') throw new Error('Private storage and secure downloader required');
  const sourceUrl = job.file_url || job.fileUrl;
  if (typeof sourceUrl !== 'string') throw new Error('Missing Skybox image URL');
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !/^(?:[a-z0-9-]+\\.)*blockadelabs\\.com$/i.test(parsed.hostname)) throw new Error('Untrusted Skybox image host');
  // download must enforce redirect blocking, DNS/IP restrictions and a byte cap.
  const payload = await download(sourceUrl, { maxBytes, redirect: 'error' });
  const image = validateAi360Image(payload);
  if (image.bytes.length > maxBytes) throw new Error('Image exceeds limit');
  const index = ['Гостиная', 'Спальня', 'Кухня', 'Санузел', 'Коридор'].indexOf(room) + 1;
  const id = Number(job.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid job ID');
  const path = `projects/${Number(projectId)}/360/${Number(tour.id)}/skybox_${index}_${id}.${image.extension}`;
  const saved = await privateStorage.upload({ path, bytes: image.bytes, contentType: image.mimeType, upsert: false });
  if (!saved || saved.ok !== true) throw new Error('Private draft upload failed');
  return { room, storage_path: path, status: 'DRAFT_UPLOADED_NOT_PUBLISHED', requiresProjectionValidation: true, requiresFloorplanReview: true };
}
