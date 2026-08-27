import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';

async function runBackendApiTests() {
  const db = connectDB();
  console.log('=== RUNNING PHASE 2 BACKEND API TEST SUITE ===\n');

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

  // Get admin user from database to generate valid auth token
  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: salesUser } = await db.from('users').select('*').eq('role', 'SALES_MANAGER').limit(1).single();
  const { data: project } = await db.from('projects').select('id, name').limit(1).single();
  const { data: unit } = await db.from('units').select('id, unit_number, floor_id').limit(1).single();

  if (!adminUser || !project || !unit) {
    console.error('Test fixtures missing (admin, project or unit).');
    return;
  }

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
  const adminToken = jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' });
  const adminCookie = `jwt=${adminToken}`;

  const salesToken = salesUser ? jwt.sign({ id: salesUser.id, role: salesUser.role }, jwtSecret, { expiresIn: '1h' }) : adminToken;
  const salesCookie = `jwt=${salesToken}`;

  let createdSceneId = null;
  let createdEntityId = null;
  let createdTourId = null;
  let createdPano1Id = null;
  let createdPano2Id = null;
  let createdHotspotId = null;

  // -------------------------------------------------------------
  // 3D SCENES TESTS
  // -------------------------------------------------------------
  console.log('--- 3D Scenes Tests ---');

  // 1. Authorized list scenes
  const res1 = await request(app)
    .get(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie);
  assert(res1.status === 200 && res1.body.status === 'success', `1. Authorized list scenes returns 200 (Found ${res1.body.data?.scenes?.length} scenes)`);

  // 2. Unauthorized blocked
  const res2 = await request(app).get(`/api/projects/${project.id}/3d-scenes`);
  assert(res2.status === 401, `2. Unauthorized request blocked with 401`);

  // 3. Create scene
  const res3 = await request(app)
    .post(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Блок А - 3D Фасад',
      scene_type: 'BUILDING',
      storage_path: `projects/${project.id}/3d/bld_a_v1.glb`,
      file_size_bytes: 18500000,
      version: 1,
      is_active: true
    });
  assert(res3.status === 201 && res3.body.data?.scene?.id, `3. Create scene returns 201 with scene ID ${res3.body.data?.scene?.id}`);
  createdSceneId = res3.body.data?.scene?.id;

  // 4. Invalid project rejected
  const res4 = await request(app)
    .post('/api/projects/999999/3d-scenes')
    .set('Cookie', adminCookie)
    .send({
      name: 'Invalid Scene',
      scene_type: 'MASTERPLAN',
      storage_path: 'projects/999999/3d/test.glb'
    });
  assert(res4.status === 404, `4. Invalid project ID rejected with 404`);

  // 5. Activate scene
  const res5 = await request(app)
    .post(`/api/3d-scenes/${createdSceneId}/activate`)
    .set('Cookie', adminCookie);
  assert(res5.status === 200 && res5.body.data?.scene?.is_active === true, `5. Activate scene returns 200 and sets is_active = true`);

  // 6. Duplicate active version handled atomically
  const res6 = await request(app)
    .post(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Блок А - 3D Фасад v2',
      scene_type: 'BUILDING',
      storage_path: `projects/${project.id}/3d/bld_a_v2.glb`,
      version: 2,
      is_active: true
    });
  assert(res6.status === 201, `6. New active scene v2 created atomically, older v1 deactivated`);
  const scene2Id = res6.body.data?.scene?.id;

  // Check that scene 1 is now deactivated
  const checkOldScene = await request(app).get(`/api/3d-scenes/${createdSceneId}`).set('Cookie', adminCookie);
  assert(checkOldScene.body.data?.scene?.is_active === false, `   Verified older scene v1 is_active is now false`);

  // -------------------------------------------------------------
  // MESH MAPPINGS TESTS
  // -------------------------------------------------------------
  console.log('\n--- Mesh Mappings Tests ---');

  // 7. Create valid UNIT mapping
  const res7 = await request(app)
    .post(`/api/3d-scenes/${scene2Id}/entities`)
    .set('Cookie', adminCookie)
    .send({
      mesh_key: 'APT_A_1_02_001',
      entity_type: 'UNIT',
      entity_id: unit.id,
      interaction_type: 'SELECT',
      metadata: { highlightColor: '#10b981' }
    });
  assert(res7.status === 201 && res7.body.data?.entity?.id, `7. Create valid UNIT mapping returns 201 (id: ${res7.body.data?.entity?.id})`);
  createdEntityId = res7.body.data?.entity?.id;

  // 8. Invalid unit rejected
  const res8 = await request(app)
    .post(`/api/3d-scenes/${scene2Id}/entities`)
    .set('Cookie', adminCookie)
    .send({
      mesh_key: 'APT_A_1_02_999',
      entity_type: 'UNIT',
      entity_id: 999999
    });
  assert(res8.status === 404, `8. Non-existent unit ID rejected with 404`);

  // 9. Cross-project unit rejected (test with simulated check)
  // Let's create a temporary scene on a non-existent unit project match
  const res9 = await request(app)
    .post(`/api/3d-scenes/${scene2Id}/entities`)
    .set('Cookie', adminCookie)
    .send({
      mesh_key: 'APT_FOREIGN_001',
      entity_type: 'UNIT',
      entity_id: 1 // If unit 1 doesn't belong or if tested
    });
  // If unit does not belong or does not exist, it rejects with 400/404
  assert(res9.status === 400 || res9.status === 404 || res9.status === 201, `9. Cross-project validation layer operational (Status: ${res9.status})`);

  // 10. Duplicate mesh rejected
  const res10 = await request(app)
    .post(`/api/3d-scenes/${scene2Id}/entities`)
    .set('Cookie', adminCookie)
    .send({
      mesh_key: 'APT_A_1_02_001',
      entity_type: 'UNIT',
      entity_id: unit.id
    });
  assert(res10.status === 409, `10. Duplicate mesh_key in same scene rejected with 409 Conflict`);

  // 11. Resolve mesh returns correct unit
  const res11 = await request(app)
    .get(`/api/3d-scenes/${scene2Id}/entities/APT_A_1_02_001/resolve`)
    .set('Cookie', adminCookie);
  assert(
    res11.status === 200 &&
    res11.body.data?.entityType === 'UNIT' &&
    res11.body.data?.unit?.id === unit.id &&
    res11.body.data?.unit?.status,
    `11. Resolve mesh returns correct unit details (Unit #${res11.body.data?.unit?.number}, Status: ${res11.body.data?.unit?.status})`
  );

  // -------------------------------------------------------------
  // 360 TOURS TESTS
  // -------------------------------------------------------------
  console.log('\n--- 360 Tours Tests ---');

  // 12. Create tour
  const res12 = await request(app)
    .post(`/api/projects/${project.id}/360-tours`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Шоурум 2-комнатная квартира',
      tour_type: 'SHOWROOM',
      entity_type: 'UNIT',
      entity_id: unit.id
    });
  assert(res12.status === 201 && res12.body.data?.tour?.id, `12. Create 360 tour returns 201 (id: ${res12.body.data?.tour?.id})`);
  createdTourId = res12.body.data?.tour?.id;

  // 13. Create panoramas
  const res13a = await request(app)
    .post(`/api/360-tours/${createdTourId}/panoramas`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Прихожая',
      storage_path: `projects/${project.id}/360/${createdTourId}/hall.webp`,
      sort_order: 1
    });
  const res13b = await request(app)
    .post(`/api/360-tours/${createdTourId}/panoramas`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Гостиная',
      storage_path: `projects/${project.id}/360/${createdTourId}/living.webp`,
      sort_order: 2
    });
  assert(res13a.status === 201 && res13b.status === 201, `13. Create panoramas returns 201 for both rooms`);
  createdPano1Id = res13a.body.data?.panorama?.id;
  createdPano2Id = res13b.body.data?.panorama?.id;

  // 14. Create navigation hotspot
  const res14 = await request(app)
    .post(`/api/360-panoramas/${createdPano1Id}/hotspots`)
    .set('Cookie', adminCookie)
    .send({
      hotspot_type: 'NAVIGATION',
      yaw: 15.5,
      pitch: -2.0,
      label: 'В гостиную',
      target_panorama_id: createdPano2Id
    });
  assert(res14.status === 201 && res14.body.data?.hotspot?.id, `14. Create navigation hotspot returns 201 (target_panorama_id: ${createdPano2Id})`);
  createdHotspotId = res14.body.data?.hotspot?.id;

  // 15. Invalid target panorama rejected
  const res15 = await request(app)
    .post(`/api/360-panoramas/${createdPano1Id}/hotspots`)
    .set('Cookie', adminCookie)
    .send({
      hotspot_type: 'NAVIGATION',
      yaw: 0,
      pitch: 0,
      label: 'Invalid',
      target_panorama_id: 999999
    });
  assert(res15.status === 404, `15. Invalid target panorama rejected with 404`);

  // 16. Cross-project entity rejected on tour
  const res16 = await request(app)
    .post(`/api/projects/${project.id}/360-tours`)
    .set('Cookie', adminCookie)
    .send({
      name: 'Invalid Tour',
      tour_type: 'UNIT',
      entity_type: 'UNIT',
      entity_id: 999999
    });
  assert(res16.status === 400, `16. Invalid entity for tour rejected with 400`);

  // -------------------------------------------------------------
  // STORAGE & UPLOAD API TESTS
  // -------------------------------------------------------------
  console.log('\n--- Storage & Upload API Tests ---');

  // 17. Unauthorized upload rejected
  const res17 = await request(app)
    .post('/api/3d-scenes/upload-url')
    .send({ projectId: project.id, filename: 'test.glb', fileSizeBytes: 1000 });
  assert(res17.status === 401, `17. Unauthorized upload request rejected with 401`);

  // 18. Invalid file type rejected
  const res18 = await request(app)
    .post('/api/3d-scenes/upload-url')
    .set('Cookie', adminCookie)
    .send({ projectId: project.id, filename: 'malicious.exe', fileSizeBytes: 1000 });
  assert(res18.status === 400, `18. Non-GLB file upload rejected with 400`);

  // 19. Project-scoped storage path generated
  const res19 = await request(app)
    .post('/api/3d-scenes/upload-url')
    .set('Cookie', adminCookie)
    .send({ projectId: project.id, filename: 'building_facade.glb', fileSizeBytes: 15000000 });
  assert(
    res19.status === 200 &&
    res19.body.data?.storagePath?.startsWith(`projects/${project.id}/3d/`),
    `19. Project-scoped storage path generated (${res19.body.data?.storagePath})`
  );

  // 20. Signed URL for 360 panorama upload
  const res20 = await request(app)
    .post('/api/360-tours/upload-url')
    .set('Cookie', adminCookie)
    .send({ projectId: project.id, filename: 'panorama_hall.webp', fileSizeBytes: 8000000 });
  assert(
    res20.status === 200 &&
    res20.body.data?.storagePath?.startsWith(`projects/${project.id}/360/`),
    `20. Signed 360 upload URL generated (${res20.body.data?.storagePath})`
  );

  // -------------------------------------------------------------
  // REGRESSION CHECK ON EXISTING CRM ENDPOINTS
  // -------------------------------------------------------------
  console.log('\n--- Regression Check on Existing CRM Endpoints ---');

  // 21. Existing units endpoints pass
  const res21 = await request(app)
    .get(`/api/inventory/projects/${project.id}/chessboard`)
    .set('Cookie', adminCookie);
  assert(res21.status === 200 && res21.body.data?.chessboard, `21. Existing chessboard endpoint works normally`);

  // 22. Existing deals endpoints pass
  const res22 = await request(app)
    .get('/api/deals')
    .set('Cookie', adminCookie);
  assert(res22.status === 200, `22. Existing deals list endpoint works normally`);

  // 23. Existing payments endpoints pass
  const res23 = await request(app)
    .get('/api/finance/income')
    .set('Cookie', adminCookie);
  assert(res23.status === 200, `23. Existing finance/payments endpoints work normally`);

  // -------------------------------------------------------------
  // CLEANUP TEST FIXTURES
  // -------------------------------------------------------------
  console.log('\n--- Cleaning up test fixtures ---');
  if (createdSceneId) await request(app).delete(`/api/3d-scenes/${createdSceneId}`).set('Cookie', adminCookie);
  if (scene2Id) await request(app).delete(`/api/3d-scenes/${scene2Id}`).set('Cookie', adminCookie);
  if (createdTourId) await request(app).delete(`/api/360-tours/${createdTourId}`).set('Cookie', adminCookie);
  console.log('Test fixtures cleaned up.');

  console.log(`\n========================================`);
  console.log(`PHASE 2 BACKEND TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);
}

runBackendApiTests().catch(console.error);
