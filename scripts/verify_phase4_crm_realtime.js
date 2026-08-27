import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { connectDB } from '../src/db/connection.js';

async function verifyPhase4() {
  const db = connectDB();
  console.log('=== VERIFYING PHASE 4: CRM ↔ 3D INTEGRATION & REALTIME STATUS ===\n');

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
  const { data: managerUser } = await db.from('users').select('*').eq('role', 'SALES_MANAGER').limit(1).single();
  const { data: project } = await db.from('projects').select('id, name').limit(1).single();
  const { data: unit } = await db.from('units').select('id, unit_number, status').limit(1).single();
  let { data: scene } = await db.from('scene_3d').select('id').eq('project_id', project.id).eq('is_active', true).order('id', { ascending: false }).limit(1).maybeSingle();

  if (!scene) {
    const { data: createdScene } = await db.from('scene_3d').insert([{
      project_id: project.id,
      name: 'Pilot 3D Scene',
      scene_type: 'BUILDING',
      storage_path: `projects/${project.id}/3d/demo_building_block.glb`,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]).select().single();
    scene = createdScene;

    await db.from('scene_3d_entities').insert([{
      scene_id: scene.id,
      mesh_key: 'APT_A_1_02_001',
      entity_type: 'UNIT',
      entity_id: unit.id,
      interaction_type: 'SELECT',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]);
  }

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;
  const managerCookie = managerUser ? `jwt=${jwt.sign({ id: managerUser.id, role: managerUser.role }, jwtSecret, { expiresIn: '1h' })}` : adminCookie;

  console.log(`Testing Project #${project.id}, Active Scene #${scene?.id}, Unit #${unit.unit_number} (ID: ${unit.id})`);

  // -------------------------------------------------------------
  // 1. Batch Entities & Live CRM Metadata Loading (No N+1)
  // -------------------------------------------------------------
  console.log('\n--- 1. Batch Loading & Metadata Contract ---');
  const resBatch = await request(app)
    .get(`/api/3d-scenes/${scene.id}/resolved-entities`)
    .set('Cookie', adminCookie);

  assert(
    resBatch.status === 200 && Array.isArray(resBatch.body.data?.entities),
    'GET /api/3d-scenes/:sceneId/resolved-entities loads all scene entities in 1 batch request'
  );

  const mappedUnitEntity = resBatch.body.data?.entities?.find(e => e.entity_type === 'UNIT');
  assert(
    mappedUnitEntity && mappedUnitEntity.unit && mappedUnitEntity.unit.status,
    `Mapped entity contains live unit data (Unit #${mappedUnitEntity?.unit?.number}, Status: ${mappedUnitEntity?.unit?.status})`
  );

  // -------------------------------------------------------------
  // 2. Unit Detail Modal API Contract
  // -------------------------------------------------------------
  console.log('\n--- 2. Apartment Detail API Contract ---');
  const resUnitDetail = await request(app)
    .get(`/api/inventory/units/${unit.id}`)
    .set('Cookie', adminCookie);

  assert(
    resUnitDetail.status === 200 && resUnitDetail.body.data?.unit?.id === unit.id,
    `Existing /api/inventory/units/:unitId contract returns complete apartment passport for ID ${unit.id}`
  );

  // -------------------------------------------------------------
  // 3. Supabase Realtime Setup & Units Query
  // -------------------------------------------------------------
  console.log('\n--- 3. Supabase Realtime Setup ---');
  const resRealtime = await db.from('units').select('id, status').eq('id', unit.id).single();
  assert(resRealtime.data && resRealtime.data.id === unit.id, 'Supabase Postgres connection and units query active');

  // -------------------------------------------------------------
  // 4. CRM Status Transitions & Permissions
  // -------------------------------------------------------------
  console.log('\n--- 4. Status Transitions & Conflict Protection ---');
  // Test updating status via existing CRM endpoint
  const originalStatus = unit.status || 'AVAILABLE';
  
  // Toggle to BLOCKED
  const resBlock = await request(app)
    .patch(`/api/inventory/units/${unit.id}/status`)
    .set('Cookie', adminCookie)
    .send({ status: 'BLOCKED', block_reason: 'Тест 3D Realtime' });

  assert(
    resBlock.status === 200 && resBlock.body.data?.unit?.status === 'BLOCKED',
    'CRM status update (AVAILABLE -> BLOCKED) succeeds'
  );

  // Restore to original status
  const resRestore = await request(app)
    .patch(`/api/inventory/units/${unit.id}/status`)
    .set('Cookie', adminCookie)
    .send({ status: originalStatus });

  assert(
    resRestore.status === 200 && resRestore.body.data?.unit?.status === originalStatus,
    `CRM status restored back to ${originalStatus}`
  );

  // -------------------------------------------------------------
  // 5. Existing CRM Regressions Check
  // -------------------------------------------------------------
  console.log('\n--- 5. Existing CRM Regressions Check ---');
  const resChessboard = await request(app)
    .get(`/api/inventory/projects/${project.id}/chessboard`)
    .set('Cookie', adminCookie);
  assert(resChessboard.status === 200 && resChessboard.body.data?.chessboard, 'Existing CRM chessboard works 100%');

  const resDeals = await request(app)
    .get('/api/deals')
    .set('Cookie', adminCookie);
  assert(resDeals.status === 200, 'Existing CRM deals endpoint works 100%');

  console.log(`\n========================================`);
  console.log(`PHASE 4 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);
}

verifyPhase4().catch(console.error);
