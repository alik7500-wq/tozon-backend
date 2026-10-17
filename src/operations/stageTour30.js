import { createHash } from 'node:crypto';
import { validatePanoramaDimensions } from '../modules/tour360/ai360GenerationService.js';
import { TOUR30_FILES } from './tour30Manifest.js';
const SOURCE = 'panoramas-360-drafts';
const DESTINATION = 'panoramas-360';
const EXPECTED_EDGES = new Set(['55:56','55:57','55:59','56:55','57:55','57:58','58:57','59:55']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertTour30Context({ tour, panoramas, hotspots }) {
  if (tour?.id !== 30 || tour.project_id !== 3 || tour.entity_type !== 'UNIT' || tour.entity_id !== 83 || tour.is_active !== false) throw new Error('TOUR30_SCOPE_OR_STATE_CHANGED');
  if (panoramas?.length !== 5 || TOUR30_FILES.some(file => !panoramas.some(p => p.id === file.id && p.tour_id === 30 && p.name === file.name && p.storage_path === file.path && !p.thumbnail_path))) throw new Error('TOUR30_FILE_MANIFEST_CHANGED');
  const edges = new Set((hotspots || []).map(h => `${h.panorama_id}:${h.target_panorama_id}`));
  if (hotspots?.length !== 8 || hotspots.some(h => h.hotspot_type !== 'NAVIGATION') || edges.size !== 8 || [...EXPECTED_EDGES].some(edge => !edges.has(edge))) throw new Error('TOUR30_NAVIGATION_CHANGED');
}

export function verifyTour30File(bytes, entry) {
  if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error('TOUR30_FILE_CHECKSUM_MISMATCH');
  const { width, height } = validatePanoramaDimensions(bytes, 'image/jpeg');
  if (width !== 8192 || height !== 4096) throw new Error('TOUR30_FILE_DIMENSIONS_MISMATCH');
}

export async function copyVerifiedFile(storage, entry, readPublic) {
  if (!entry.path.startsWith('projects/3/360/30/') || entry.path.includes('..')) throw new Error('TOUR30_INVALID_PATH');
  const { data, error } = await storage.from(SOURCE).download(entry.path);
  if (error || !data) throw new Error('TOUR30_SOURCE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await data.arrayBuffer());
  verifyTour30File(bytes, entry);
  const slash = entry.path.lastIndexOf('/');
  const filename = entry.path.slice(slash + 1);
  const { data: objects, error: listError } = await storage.from(DESTINATION).list(entry.path.slice(0, slash), { search: filename, limit: 100 });
  if (listError || !Array.isArray(objects)) throw new Error('TOUR30_DESTINATION_LIST_FAILED');
  let uploaded = false;
  if (!objects.some(object => object.name === filename)) {
    const { error: uploadError } = await storage.from(DESTINATION).upload(entry.path, bytes, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
    if (uploadError) throw new Error('TOUR30_DESTINATION_UPLOAD_FAILED');
    uploaded = true;
  }
  // Anonymous HTTP verification also checks existing files. Never overwrite a mismatch.
  const publicBytes = await readPublic(entry.path);
  verifyTour30File(publicBytes, entry);
  return { panorama_id: entry.id, path: entry.path, size: bytes.length, sha256: digest(bytes), uploaded, public_read_verified: true, width: 8192, height: 4096 };
}

export async function stageTour30(db, readPublic, log = console.log) {
  const loadContext = async () => {
    const [t,p,h] = await Promise.all([
      db.from('tours_360').select('id,project_id,entity_type,entity_id,is_active').eq('id',30).single(),
      db.from('panorama_360').select('id,tour_id,name,storage_path,thumbnail_path').eq('tour_id',30),
      db.from('panorama_hotspots').select('panorama_id,target_panorama_id,hotspot_type').in('panorama_id',TOUR30_FILES.map(file=>file.id))
    ]);
    if (t.error || p.error || h.error) throw new Error('TOUR30_CONTEXT_READ_FAILED');
    const context = {tour:t.data,panoramas:p.data,hotspots:h.data};
    assertTour30Context(context);
    return context;
  };
  await loadContext();
  // Verify every source before the first public write.
  for (const file of TOUR30_FILES) {
    const {data,error}=await db.storage.from(SOURCE).download(file.path);
    if (error || !data) throw new Error('TOUR30_SOURCE_DOWNLOAD_FAILED');
    verifyTour30File(Buffer.from(await data.arrayBuffer()),file);
  }
  const files=[];
  for (const file of TOUR30_FILES) {
    await loadContext();
    const attestation=await copyVerifiedFile(db.storage,file,readPublic);
    files.push(attestation);
    log('TOUR30_FILE_VERIFIED '+JSON.stringify(attestation));
  }
  await loadContext();
  const result={tour_id:30,project_id:3,unit_id:83,verified_at:new Date().toISOString(),activated:false,files};
  log('TOUR30_STORAGE_STAGE_VERIFIED '+JSON.stringify(result));
  return result;
}
