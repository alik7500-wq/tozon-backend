import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';
import { createSampleGLB } from './generate_sample_glb.js';
import { Visual3DRepository } from '../src/modules/visual3d/visual3d.repository.js';

async function verifyPhase3() {
  const db = connectDB();
  console.log('=== VERIFYING PHASE 3: 3D VIEWER FOUNDATION & PIPELINE ===\n');

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

  // 1. Get auth user and project
  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: project } = await db.from('projects').select('id, name').limit(1).single();
  const { data: unit } = await db.from('units').select('id, unit_number').limit(1).single();

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;

  console.log(`Testing with Project #${project.id} (${project.name}), Unit #${unit.unit_number} (ID: ${unit.id})`);

  // 2. Generate and upload sample GLB binary
  console.log('\n--- 1. Storage & Asset Pipeline ---');
  const sampleGlb = createSampleGLB();
  const storagePath = `projects/${project.id}/3d/demo_building_block.glb`;

  const { error: uploadErr } = await db.storage
    .from('3d-models')
    .upload(storagePath, sampleGlb, {
      contentType: 'model/gltf-binary',
      upsert: true
    });

  assert(!uploadErr, `Sample GLB uploaded to Supabase Storage: ${storagePath} (${sampleGlb.length} bytes)`);

  // 3. Register active 3D Scene in PostgreSQL
  console.log('\n--- 2. Scene Registration & Versioning ---');
  const scene = await Visual3DRepository.create(project.id, {
    name: 'Корпус А — 3D Интерактивная модель',
    scene_type: 'BUILDING',
    storage_path: storagePath,
    file_size_bytes: sampleGlb.length,
    version: 1,
    is_active: true,
    camera_config: { position: [30, 20, 30], target: [0, 0, 0], fov: 45 },
    environment_config: { preset: 'city', exposure: 1.0, background_color: '#0f172a' }
  });

  assert(scene && scene.id, `Active 3D scene created (ID: ${scene?.id})`);

  // 4. Map mesh APT_A_1_02_001 -> unit.id
  console.log('\n--- 3. Mesh Entity Mapping ---');
  const now = new Date().toISOString();
  const { data: entity, error: entErr } = await db.from('scene_3d_entities').insert([{
    scene_id: scene.id,
    mesh_key: 'APT_A_1_02_001',
    entity_type: 'UNIT',
    entity_id: unit.id,
    interaction_type: 'SELECT',
    metadata: { floor: 2, rooms: 2 },
    created_at: now,
    updated_at: now
  }]).select().single();

  assert(!entErr && entity && entity.id, `Mesh "APT_A_1_02_001" mapped to Unit ID ${unit.id}`);

  // 5. Test Frontend API Contract: GET /api/projects/:projectId/3d-scenes
  console.log('\n--- 4. Frontend API Contract Tests ---');
  const resList = await request(app)
    .get(`/api/projects/${project.id}/3d-scenes`)
    .set('Cookie', adminCookie);

  assert(
    resList.status === 200 &&
    resList.body.data?.scenes?.length > 0 &&
    resList.body.data?.scenes[0].model_url,
    `GET /api/projects/${project.id}/3d-scenes returns scenes with valid model_url signed stream link`
  );

  // 6. Test Mesh Resolution Endpoint: GET /api/3d-scenes/:sceneId/entities/:meshKey/resolve
  const resResolve = await request(app)
    .get(`/api/3d-scenes/${scene.id}/entities/APT_A_1_02_001/resolve`)
    .set('Cookie', adminCookie);

  assert(
    resResolve.status === 200 &&
    resResolve.body.data?.entityType === 'UNIT' &&
    resResolve.body.data?.unit?.id === unit.id &&
    resResolve.body.data?.unit?.status,
    `GET /api/3d-scenes/${scene.id}/entities/APT_A_1_02_001/resolve returns correct unit payload (#${resResolve.body.data?.unit?.number})`
  );

  // 7. Test Unmapped Mesh Resolution returns 404 (non-intrusive)
  const resUnmapped = await request(app)
    .get(`/api/3d-scenes/${scene.id}/entities/UNMAPPED_ROOF_MESH/resolve`)
    .set('Cookie', adminCookie);

  assert(resUnmapped.status === 404, 'Unmapped mesh correctly returns 404 and does not trigger CRM state');

  // 8. Regression test: Chessboard endpoint
  console.log('\n--- 5. Existing CRM Regression Check ---');
  const resChessboard = await request(app)
    .get(`/api/inventory/projects/${project.id}/chessboard`)
    .set('Cookie', adminCookie);
  assert(resChessboard.status === 200 && resChessboard.body.data?.chessboard, 'Existing CRM chessboard works 100%');

  console.log(`\n========================================`);
  console.log(`PHASE 3 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);
}

verifyPhase3().catch(console.error);
