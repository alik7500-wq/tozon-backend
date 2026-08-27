import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';
import { createSamplePanoramaPNG } from './generate_sample_panorama.js';
import { Tour360Repository } from '../src/modules/tour360/tour360.repository.js';

async function verifyPhase5() {
  const db = connectDB();
  console.log('=== VERIFYING PHASE 5: 360° SPHERE VIEWER FOUNDATION & PIPELINE ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Auth and test entities
  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: project } = await db.from('projects').select('id, name').limit(1).single();
  const { data: unit } = await db.from('units').select('id, unit_number').limit(1).single();

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;

  console.log(`Testing Project #${project.id} (${project.name}), Unit #${unit.unit_number} (ID: ${unit.id})`);

  // 2. Upload sample 360 panorama to storage bucket 'panoramas-360'
  console.log('\n--- 1. Storage & Panorama Asset Pipeline ---');
  const samplePan = createSamplePanoramaPNG();
  const storagePath1 = `projects/${project.id}/panoramas/living_room.png`;
  const storagePath2 = `projects/${project.id}/panoramas/bedroom.png`;

  const { error: upErr1 } = await db.storage
    .from('panoramas-360')
    .upload(storagePath1, samplePan, { contentType: 'image/png', upsert: true });
  assert(!upErr1, `Uploaded panorama 1 to storage: ${storagePath1}`);

  const { error: upErr2 } = await db.storage
    .from('panoramas-360')
    .upload(storagePath2, samplePan, { contentType: 'image/png', upsert: true });
  assert(!upErr2, `Uploaded panorama 2 to storage: ${storagePath2}`);

  // 3. Create 360 Tour via Repository
  console.log('\n--- 2. Tour Creation & Repository ---');
  const tour = await Tour360Repository.createTour(project.id, {
    name: 'Шоурум 2-комнатной квартиры (360°)',
    tour_type: 'SHOWROOM',
    is_active: true
  });
  assert(tour && tour.id, `Created 360 Tour ID: ${tour?.id}`);

  // 4. Create 2 Panoramas
  console.log('\n--- 3. Panoramas & Spherical Coordinates ---');
  const pan1 = await Tour360Repository.createPanorama(tour.id, {
    title: 'Гостиная и кухня-студия',
    storage_path: storagePath1,
    file_size_bytes: samplePan.length,
    is_entry: true,
    initial_yaw: 0,
    initial_pitch: 0,
    initial_fov: 75
  });
  assert(pan1 && pan1.id, `Created Entry Panorama 1 (ID: ${pan1?.id})`);

  const pan2 = await Tour360Repository.createPanorama(tour.id, {
    title: 'Мастер-спальня',
    storage_path: storagePath2,
    file_size_bytes: samplePan.length,
    is_entry: false,
    initial_yaw: 45,
    initial_pitch: -10,
    initial_fov: 70
  });
  assert(pan2 && pan2.id, `Created Panorama 2 (ID: ${pan2?.id})`);

  // 5. Create Hotspots: NAVIGATION, INFO, UNIT
  console.log('\n--- 4. Hotspots (Navigation, Info, Unit) ---');
  const navHotspot = await Tour360Repository.createHotspot(pan1.id, {
    hotspot_type: 'NAVIGATION',
    title: 'Перейти в спальню',
    yaw: 45,
    pitch: 5,
    target_panorama_id: pan2.id
  });
  assert(navHotspot && navHotspot.id, `Created NAVIGATION Hotspot -> Panorama ${pan2.id}`);

  const infoHotspot = await Tour360Repository.createHotspot(pan1.id, {
    hotspot_type: 'INFO',
    title: 'Панорамное остекление',
    yaw: -30,
    pitch: 10,
    metadata: { description: 'Двухкамерные энергосберегающие стеклопакеты Schuco' }
  });
  assert(infoHotspot && infoHotspot.id, `Created INFO Hotspot with metadata`);

  const unitHotspot = await Tour360Repository.createHotspot(pan1.id, {
    hotspot_type: 'UNIT',
    title: `Квартира №${unit.unit_number}`,
    yaw: 90,
    pitch: 0,
    entity_id: unit.id
  });
  assert(unitHotspot && unitHotspot.id, `Created UNIT Hotspot -> Unit ID ${unit.id}`);

  // 6. Test REST API Endpoints & Signed URLs
  console.log('\n--- 5. REST API & Signed URL Verification ---');
  const resTours = await request(app)
    .get(`/api/projects/${project.id}/360-tours`)
    .set('Cookie', adminCookie);

  assert(
    resTours.status === 200 && resTours.body.data?.tours?.length > 0,
    `GET /api/projects/${project.id}/360-tours returns project tours`
  );

  const resTourTree = await request(app)
    .get(`/api/360-tours/${tour.id}`)
    .set('Cookie', adminCookie);

  assert(
    resTourTree.status === 200 &&
    resTourTree.body.data?.tour?.panoramas?.length === 2 &&
    resTourTree.body.data?.tour?.panoramas[0].panorama_url &&
    resTourTree.body.data?.tour?.panoramas[0].hotspots?.length === 3,
    `GET /api/360-tours/${tour.id} returns full tree with Signed URLs and hotspots`
  );

  // 7. Regression check
  console.log('\n--- 6. Existing CRM & 3D Regressions Check ---');
  const res3D = await request(app)
    .get(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie);
  assert(res3D.status === 200, '3D scenes endpoint works 100%');

  const resChess = await request(app)
    .get(`/api/inventory/projects/${project.id}/chessboard`)
    .set('Cookie', adminCookie);
  assert(resChess.status === 200, 'Chessboard endpoint works 100%');

  console.log(`\n========================================`);
  console.log(`PHASE 5 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);
}

verifyPhase5().catch(console.error);
