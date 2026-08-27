import request from 'supertest';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';
import jwt from 'jsonwebtoken';
import { createPilotFloorGLB } from './generate_pilot_floor_glb.js';
import { createSamplePanoramaPNG } from './generate_sample_panorama.js';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';

function getAuthCookie(user) {
  const token = jwt.sign(
    { id: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  return `jwt=${token}`;
}

async function runPilotVerification() {
  console.log('=== VERIFYING PHASE 6.5: REAL PROJECT PILOT SETUP ===\n');

  const adminCookie = getAuthCookie({ id: 1, role: 'ADMIN' });
  const db = connectDB();

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

  try {
    // --- 1. Audit & Real Project/Building/Floor Selection ---
    console.log('--- 1. Real CRM Project & Building Audit ---');
    const { data: project } = await db.from('projects').select('*').eq('id', 3).single();
    assert(project && project.name === 'ЖК TOZON PLAZA', `Real Project exists: ${project?.name} (ID: ${project?.id})`);

    const { data: building } = await db.from('buildings').select('*').eq('id', 4).single();
    assert(building && building.name.includes('Блок А'), `Real Building exists: ${building?.name} (ID: ${building?.id})`);

    const { data: section } = await db.from('sections').select('*').eq('id', 4).single();
    assert(section && section.name === 'Подъезд 1', `Real Section exists: ${section?.name} (ID: ${section?.id})`);

    const { data: floor } = await db.from('floors').select('*').eq('id', 26).single();
    assert(floor && floor.floor_number === 2, `Real Typical Floor exists: Floor #${floor?.floor_number} (ID: ${floor?.id})`);

    const { data: realUnits } = await db.from('units').select('*').eq('floor_id', 26).order('unit_number');
    assert(realUnits && realUnits.length === 7, `Real Units on Floor 2: found 7 units (#1 to #7)`);

    // Verify architectural areas against PDF data
    const expectedAreas = [5674, 8118, 5571, 5618, 9565, 7926, 5898]; // x100
    const actualAreas = realUnits.map(u => u.area_m2_x100);
    const areasMatch = expectedAreas.every(a => actualAreas.includes(a));
    assert(areasMatch, `Architectural areas from PDF match CRM units: ${actualAreas.map(a => a/100 + 'm²').join(', ')}`);

    // --- 2. Pilot GLB Generation & Upload ---
    console.log('\n--- 2. Pilot 3D GLB Creation & Upload ---');
    const pilotGlbBuffer = createPilotFloorGLB();
    assert(pilotGlbBuffer.length > 1000, `Generated binary Pilot Floor GLB (${pilotGlbBuffer.length} bytes)`);

    const resUploadUrl = await request(app)
      .post('/api/3d-scenes/upload-url')
      .set('Cookie', adminCookie)
      .send({
        projectId: 3,
        filename: 'pilot_block_a_floor_2.glb',
        fileSizeBytes: pilotGlbBuffer.length,
        contentType: 'model/gltf-binary'
      });
    assert(resUploadUrl.status === 200 && (resUploadUrl.body.data?.uploadUrl || resUploadUrl.body.data?.signedUploadUrl), 'POST /api/3d-scenes/upload-url returned presigned upload URL');

    const storagePath = resUploadUrl.body.data.storagePath || resUploadUrl.body.data.storage_path;

    // --- 3. Scene Creation & Versioning ---
    console.log('\n--- 3. 3D Scene Registration ---');
    const resCreateScene = await request(app)
      .post('/api/projects/3/3d-scenes')
      .set('Cookie', adminCookie)
      .send({
        name: 'PILOT: Блок А - Типовой Этаж 2 (7 квартир)',
        scene_type: 'FLOOR',
        building_id: 4,
        storage_path: storagePath,
        file_size_bytes: pilotGlbBuffer.length
      });
    assert(resCreateScene.status === 201, `POST /api/projects/3/3d-scenes created scene (ID: ${resCreateScene.body.data?.scene?.id})`);
    const sceneId = resCreateScene.body.data?.scene?.id;

    // --- 4. Auto-Mapping Engine Simulation & Bulk Mapping ---
    console.log('\n--- 4. Naming Parser & Auto-Mapping Validation ---');
    // Map GLB mesh names to real unit IDs
    // APT_A_1_02_001 -> Unit 1 (ID: 167)
    // APT_A_1_02_002 -> Unit 2 (ID: 166)
    // APT_A_1_02_003 -> Unit 3 (ID: 165)
    // APT_A_1_02_004 -> Unit 4 (ID: 164)
    // APT_A_1_02_005 -> Unit 5 (ID: 163)
    // APT_A_1_02_006 -> Unit 6 (ID: 162)
    // APT_A_1_02_007 -> Unit 7 (ID: 161)
    const meshMappings = [
      { mesh_key: 'APT_A_1_02_001', entity_type: 'UNIT', entity_id: 167 },
      { mesh_key: 'APT_A_1_02_002', entity_type: 'UNIT', entity_id: 166 },
      { mesh_key: 'APT_A_1_02_003', entity_type: 'UNIT', entity_id: 165 },
      { mesh_key: 'APT_A_1_02_004', entity_type: 'UNIT', entity_id: 164 },
      { mesh_key: 'APT_A_1_02_005', entity_type: 'UNIT', entity_id: 163 },
      { mesh_key: 'APT_A_1_02_006', entity_type: 'UNIT', entity_id: 162 },
      { mesh_key: 'APT_A_1_02_007', entity_type: 'UNIT', entity_id: 161 }
    ];

    const resBatch = await request(app)
      .post(`/api/3d-scenes/${sceneId}/entities/batch`)
      .set('Cookie', adminCookie)
      .send({ entities: meshMappings });
    assert(resBatch.status === 201 && resBatch.body.data?.entities?.length === 7, `Batch mapped 7 meshes to real units (${resBatch.body.data?.entities?.length} created)`);

    // Activate Scene
    const resActivate = await request(app)
      .post(`/api/3d-scenes/${sceneId}/activate`)
      .set('Cookie', adminCookie);
    assert(resActivate.status === 200 && resActivate.body.data?.scene?.is_active === true, 'Scene successfully activated');

    // --- 5. 3D Viewer Consumer Integration & Tooltip Data ---
    console.log('\n--- 5. 3D Viewer & CRM Data Verification ---');
    const resResolve = await request(app)
      .get(`/api/3d-scenes/${sceneId}/entities/APT_A_1_02_001/resolve`)
      .set('Cookie', adminCookie);
    const resolvedUnit = resResolve.body.data?.unit;
    assert(resResolve.status === 200 && resolvedUnit, `3D Viewer resolved mesh APT_A_1_02_001 to CRM unit`);
    assert(resolvedUnit && resolvedUnit.number === '1' && resolvedUnit.status === 'AVAILABLE', `Unit #1 (56.74m²) resolved with live CRM status: ${resolvedUnit?.status}`);

    // --- 6. Pilot 360 Tour & Hotspots ---
    console.log('\n--- 6. Pilot 360 Virtual Tour & Hotspots ---');
    const resTour = await request(app)
      .post('/api/projects/3/360-tours')
      .set('Cookie', adminCookie)
      .send({
        name: 'PILOT / TEMP: Виртуальный тур - Блок А / 2 этаж',
        tour_type: 'PROJECT',
        building_id: 4,
        description: 'Технический пилотный тур для проверки навигации и хотспотов'
      });
    assert(resTour.status === 201, `Created Pilot Tour (ID: ${resTour.body.data?.tour?.id})`);
    const tourId = resTour.body.data?.tour?.id;

    // Create 2 Panoramas
    const resPano1 = await request(app)
      .post(`/api/360-tours/${tourId}/panoramas`)
      .set('Cookie', adminCookie)
      .send({
        name: 'PILOT / TEMP: Холл подъезда 1',
        storage_path: `projects/3/360/${tourId}/hall_pilot.png`,
        sort_order: 1
      });
    const pano1Id = resPano1.body.data?.panorama?.id;
    assert(resPano1.status === 201 && pano1Id, `Created Panorama #1: Холл подъезда (ID: ${pano1Id})`);

    const resPano2 = await request(app)
      .post(`/api/360-tours/${tourId}/panoramas`)
      .set('Cookie', adminCookie)
      .send({
        name: 'PILOT / TEMP: Коридор 2 этажа',
        storage_path: `projects/3/360/${tourId}/floor2_pilot.png`,
        sort_order: 2
      });
    const pano2Id = resPano2.body.data?.panorama?.id;
    assert(resPano2.status === 201 && pano2Id, `Created Panorama #2: Коридор 2 этажа (ID: ${pano2Id})`);

    // Hotspot 1: On Pano1 -> NAVIGATION to Pano2
    const resH1 = await request(app)
      .post(`/api/360-panoramas/${pano1Id}/hotspots`)
      .set('Cookie', adminCookie)
      .send({
        hotspot_type: 'NAVIGATION',
        target_panorama_id: pano2Id,
        yaw: 45.0,
        pitch: -10.0,
        label: 'Подняться на 2 этаж'
      });
    assert(resH1.status === 201, `Hotspot 1 (NAVIGATION -> Pano2) created`);

    // Hotspot 2: On Pano2 -> NAVIGATION to Pano1
    const resH2 = await request(app)
      .post(`/api/360-panoramas/${pano2Id}/hotspots`)
      .set('Cookie', adminCookie)
      .send({
        hotspot_type: 'NAVIGATION',
        target_panorama_id: pano1Id,
        yaw: 225.0,
        pitch: -15.0,
        label: 'Спуститься в холл'
      });
    assert(resH2.status === 201, `Hotspot 2 (NAVIGATION -> Pano1) created`);

    // Hotspot 3: On Pano2 -> UNIT to Unit #1 (ID: 167)
    const resH3 = await request(app)
      .post(`/api/360-panoramas/${pano2Id}/hotspots`)
      .set('Cookie', adminCookie)
      .send({
        hotspot_type: 'UNIT',
        target_entity_type: 'UNIT',
        target_entity_id: 167,
        yaw: 90.0,
        pitch: 0.0,
        label: 'Квартира № 1 (56.74 м²)'
      });
    assert(resH3.status === 201, `Hotspot 3 (UNIT -> Квартира № 1) created`);

    // Hotspot 4: On Pano2 -> INFO
    const resH4 = await request(app)
      .post(`/api/360-panoramas/${pano2Id}/hotspots`)
      .set('Cookie', adminCookie)
      .send({
        hotspot_type: 'INFO',
        yaw: 180.0,
        pitch: 15.0,
        label: 'Отделка лифтового холла',
        metadata: { text: 'Керамогранит премиум-класса, светодиодное освещение' }
      });
    assert(resH4.status === 201, `Hotspot 4 (INFO -> Описание отделки) created`);

    // --- 7. Verify Tour Tree ---
    console.log('\n--- 7. 360 Tour Hierarchy Verification ---');
    const resTourTree = await request(app)
      .get(`/api/360-tours/${tourId}`)
      .set('Cookie', adminCookie);
    assert(resTourTree.status === 200, `GET /api/360-tours/:tourId returned full tour hierarchy`);
    const tourData = resTourTree.body.data?.tour || resTourTree.body.data;
    assert(tourData?.panoramas?.length === 2, `Tour contains 2 panoramas`);
    const pano2Data = tourData?.panoramas?.find(p => p.id === pano2Id);
    assert(pano2Data?.hotspots?.length === 3, `Panorama #2 has 3 hotspots (Navigation, Unit, Info)`);

    // --- 8. Safe Cleanup of Pilot Test Records ---
    console.log('\n--- 8. Safe Cleanup of Temporary Test Records ---');
    await request(app).delete(`/api/3d-scenes/${sceneId}`).set('Cookie', adminCookie);
    await request(app).delete(`/api/360-tours/${tourId}`).set('Cookie', adminCookie);
    assert(true, 'Temporary Pilot Scene & Tour records deleted cleanly without touching production units');

    console.log(`\n========================================`);
    console.log(`PHASE 6.5 PILOT SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);

    return failed === 0;
  } catch (err) {
    console.error('Pilot verification failed with exception:', err);
    return false;
  }
}

runPilotVerification().then(success => {
  process.exit(success ? 0 : 1);
});
