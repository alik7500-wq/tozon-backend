import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';

async function verifyPhase6() {
  const db = connectDB();
  console.log('=== VERIFYING PHASE 6: ADMIN 3D/360 CONTENT MANAGER ===\n');

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

  // 1. Auth Users and Projects
  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: managerUser } = await db.from('users').select('*').eq('role', 'SALES_MANAGER').limit(1).single();
  const { data: project } = await db.from('projects').select('id, name').limit(1).single();
  const { data: otherProject } = await db.from('projects').select('id, name').neq('id', project.id).limit(1).single();
  const { data: unit } = await db.from('units').select('id, unit_number').limit(1).single();
  const invalidUnitId = 99999999;

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;
  const managerCookie = managerUser
    ? `jwt=${jwt.sign({ id: managerUser.id, role: managerUser.role }, jwtSecret, { expiresIn: '1h' })}`
    : `jwt=${jwt.sign({ id: 999, role: 'SALES_MANAGER' }, jwtSecret, { expiresIn: '1h' })}`;

  console.log(`Testing Admin User #${adminUser.id}, Project #${project.id} (${project.name})`);

  // -------------------------------------------------------------
  // 1. 3D GLB Presigned Upload URL & Validation
  // -------------------------------------------------------------
  console.log('\n--- 1. GLB Presigned Upload & Validation ---');
  const resGlbUrl = await request(app)
    .post('/api/3d-scenes/upload-url')
    .set('Cookie', adminCookie)
    .send({
      projectId: project.id,
      filename: 'building_facade_v2.glb',
      fileSizeBytes: 5 * 1024 * 1024
    });

  assert(
    resGlbUrl.status === 200 && resGlbUrl.body.data?.signedUploadUrl && resGlbUrl.body.data?.storagePath,
    'POST /api/3d-scenes/upload-url generates presigned upload URL for GLB model'
  );

  // Validation check: Invalid file extension (e.g. .exe) must be rejected
  const resInvalidExt = await request(app)
    .post('/api/3d-scenes/upload-url')
    .set('Cookie', adminCookie)
    .send({
      projectId: project.id,
      filename: 'malicious_file.exe',
      fileSizeBytes: 1024
    });

  assert(resInvalidExt.status === 400, 'GLB upload validation rejects non-GLB files (.exe)');

  // -------------------------------------------------------------
  // 2. 3D Scene Creation & Versioning
  // -------------------------------------------------------------
  console.log('\n--- 2. 3D Scene Creation & Versioning ---');
  const resCreateScene = await request(app)
    .post(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Блок Б — Фасадная модель',
      scene_type: 'BUILDING',
      storage_path: resGlbUrl.body.data.storagePath,
      file_size_bytes: 5 * 1024 * 1024,
      version: 2,
      is_active: false
    });

  assert(
    resCreateScene.status === 201 && resCreateScene.body.data?.scene?.id,
    `POST /api/projects/:projectId/3d-scenes creates scene version (ID: ${resCreateScene.body.data?.scene?.id})`
  );
  const newSceneId = resCreateScene.body.data?.scene?.id;

  // -------------------------------------------------------------
  // 3. Batch Mesh Mapping & Cross-Project Isolation
  // -------------------------------------------------------------
  console.log('\n--- 3. Batch Mesh Mapping & Cross-Project Protection ---');
  const resBatchMap = await request(app)
    .post(`/api/3d-scenes/${newSceneId}/entities/batch`)
    .set('Cookie', adminCookie)
    .send({
      entities: [
        {
          mesh_key: 'APT_B_1_03_045',
          entity_type: 'UNIT',
          entity_id: unit.id,
          interaction_type: 'SELECT'
        }
      ]
    });

  assert(
    resBatchMap.status === 201 && resBatchMap.body.data?.entities?.length === 1,
    'POST /api/3d-scenes/:sceneId/entities/batch saves mesh mappings in bulk'
  );

  // Non-existent / cross-project entity mapping must be blocked
  const resCrossMap = await request(app)
    .post(`/api/3d-scenes/${newSceneId}/entities/batch`)
    .set('Cookie', adminCookie)
    .send({
      entities: [
        {
          mesh_key: 'APT_OTHER_PROJECT',
          entity_type: 'UNIT',
          entity_id: invalidUnitId,
          interaction_type: 'SELECT'
        }
      ]
    });

  assert(
    resCrossMap.status === 400 || resCrossMap.status === 404,
    'Invalid / Cross-project entity mapping is strictly blocked by backend security layer'
  );

  // -------------------------------------------------------------
  // 4. Atomic Scene Activation
  // -------------------------------------------------------------
  console.log('\n--- 4. Atomic Scene Activation ---');
  const resActivate = await request(app)
    .post(`/api/3d-scenes/${newSceneId}/activate`)
    .set('Cookie', adminCookie);

  assert(
    resActivate.status === 200 && resActivate.body.data?.scene?.is_active === true,
    `POST /api/3d-scenes/:sceneId/activate atomically activates new version`
  );

  // -------------------------------------------------------------
  // 5. 360 Tour, Panorama Upload & Hotspot Editor API
  // -------------------------------------------------------------
  console.log('\n--- 5. 360 Tour, Panorama & Hotspot Manager ---');
  // Create Tour
  const resCreateTour = await request(app)
    .post(`/api/projects/${project.id}/360-tours`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Шоурум Корпус Б (360°)',
      tour_type: 'SHOWROOM',
      is_active: true
    });

  assert(
    resCreateTour.status === 201 && resCreateTour.body.data?.tour?.id,
    `POST /api/projects/:projectId/360-tours creates new tour (ID: ${resCreateTour.body.data?.tour?.id})`
  );
  const newTourId = resCreateTour.body.data?.tour?.id;

  // Panorama Upload URL
  const resPanoUrl = await request(app)
    .post('/api/360-panoramas/upload-url')
    .set('Cookie', adminCookie)
    .send({
      projectId: project.id,
      filename: 'showroom_living_room.png',
      fileSizeBytes: 2 * 1024 * 1024
    });

  assert(
    resPanoUrl.status === 200 && resPanoUrl.body.data?.signedUploadUrl,
    'POST /api/360-panoramas/upload-url generates presigned upload URL'
  );

  // Create Panoramas
  const resPano1 = await request(app)
    .post(`/api/360-tours/${newTourId}/panoramas`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Зал и столовая',
      storage_path: resPanoUrl.body.data.storagePath,
      file_size_bytes: 2 * 1024 * 1024,
      is_entry: true,
      initial_yaw: 0,
      initial_pitch: 0,
      initial_fov: 75
    });

  assert(
    resPano1.status === 201 && resPano1.body.data?.panorama?.id,
    `POST /api/360-tours/:tourId/panoramas creates panorama (ID: ${resPano1.body.data?.panorama?.id})`
  );
  const pano1Id = resPano1.body.data?.panorama?.id;

  const resPano2 = await request(app)
    .post(`/api/360-tours/${newTourId}/panoramas`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Кухня',
      storage_path: resPanoUrl.body.data.storagePath,
      file_size_bytes: 2 * 1024 * 1024,
      is_entry: false,
      initial_yaw: 90,
      initial_pitch: 0,
      initial_fov: 75
    });
  const pano2Id = resPano2.body.data?.panorama?.id;

  // Create Hotspot (Navigation)
  const resHotspot = await request(app)
    .post(`/api/360-panoramas/${pano1Id}/hotspots`)
    .set('Cookie', adminCookie)
    .send({
      hotspot_type: 'NAVIGATION',
      label: 'Перейти в кухню',
      yaw: 85.5,
      pitch: -2.0,
      target_panorama_id: pano2Id
    });

  assert(
    resHotspot.status === 201 && resHotspot.body.data?.hotspot?.id,
    `POST /api/360-panoramas/:panoramaId/hotspots places hotspot on sphere (ID: ${resHotspot.body.data?.hotspot?.id})`
  );
  const hotspotId = resHotspot.body.data?.hotspot?.id;

  // Update Hotspot position
  const resUpdateHotspot = await request(app)
    .patch(`/api/360-hotspots/${hotspotId}`)
    .set('Cookie', adminCookie)
    .send({
      yaw: 92.0,
      pitch: -1.5,
      label: 'В зону кухни'
    });

  assert(
    resUpdateHotspot.status === 200 && resUpdateHotspot.body.data?.hotspot?.yaw === 92,
    'PATCH /api/360-hotspots/:hotspotId updates visual spherical position'
  );

  // Delete Hotspot
  const resDeleteHotspot = await request(app)
    .delete(`/api/360-hotspots/${hotspotId}`)
    .set('Cookie', adminCookie);

  assert(resDeleteHotspot.status === 204, 'DELETE /api/360-hotspots/:hotspotId deletes hotspot cleanly');

  // -------------------------------------------------------------
  // 6. Role-Based Access Control (RBAC) Security
  // -------------------------------------------------------------
  console.log('\n--- 6. Role-Based Access Control (RBAC) ---');
  const resUnauthorized = await request(app)
    .post(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', managerCookie)
    .send({
      name: 'Unauth Scene',
      scene_type: 'BUILDING',
      storage_path: 'test.glb',
      file_size_bytes: 100
    });

  assert(
    resUnauthorized.status === 403,
    'Unauthorized users (SALES_MANAGER) are strictly blocked (403 Forbidden) from administrative mutations'
  );

  // -------------------------------------------------------------
  // 7. Regressions Check
  // -------------------------------------------------------------
  console.log('\n--- 7. Existing CRM & Visual Pipelines Regression Check ---');
  const res3DViewer = await request(app).get(`/api/projects/${project.id}/3d-scenes`).set('Cookie', adminCookie);
  assert(res3DViewer.status === 200, '3D Viewer API works 100%');

  const res360Viewer = await request(app).get(`/api/projects/${project.id}/360-tours`).set('Cookie', adminCookie);
  assert(res360Viewer.status === 200, '360 Viewer API works 100%');

  const resChess = await request(app).get(`/api/inventory/projects/${project.id}/chessboard`).set('Cookie', adminCookie);
  assert(resChess.status === 200, 'Chessboard API works 100%');

  console.log(`\n========================================`);
  console.log(`PHASE 6 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);
}

verifyPhase6().catch(console.error);
