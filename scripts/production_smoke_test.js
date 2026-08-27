import { connectDB } from '../src/db/connection.js';
import { app } from '../src/app.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const db = connectDB();

async function runSmokeTest() {
  console.log('====================================================');
  console.log('  RUNNING PRODUCTION SMOKE TEST FOR TOZON CRM');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: managerUser } = await db.from('users').select('*').eq('role', 'SALES_MANAGER').limit(1).single();
  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';

  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;
  const managerCookie = managerUser
    ? `jwt=${jwt.sign({ id: managerUser.id, role: managerUser.role }, jwtSecret, { expiresIn: '1h' })}`
    : `jwt=${jwt.sign({ id: 999, role: 'SALES_MANAGER' }, jwtSecret, { expiresIn: '1h' })}`;

  const projectId = 3; // ЖК TOZON PLAZA

  // 1. Health & Core CRM Smoke Tests
  console.log('--- 1. Core CRM Smoke Test ---');
  const healthRes = await request(app).get('/api/health');
  assert(healthRes.status === 200 && healthRes.body.status === 'ok', 'Health check responds 200 OK');

  const projectsRes = await request(app).get('/api/projects').set('Cookie', adminCookie);
  assert(projectsRes.status === 200 && projectsRes.body.data?.projects?.length > 0, 'GET /api/projects returns project list');

  const projectRes = await request(app).get(`/api/projects/${projectId}`).set('Cookie', adminCookie);
  assert(projectRes.status === 200 && projectRes.body.data?.project?.name === 'ЖК TOZON PLAZA', 'GET /api/projects/3 returns ЖК TOZON PLAZA');

  const chessboardRes = await request(app).get(`/api/inventory/projects/${projectId}/chessboard`).set('Cookie', adminCookie);
  assert(chessboardRes.status === 200 && (chessboardRes.body.data?.chessboard || chessboardRes.body.data?.buildings), 'GET /api/inventory/projects/3/chessboard returns full building grid');

  const dealsRes = await request(app).get('/api/deals').set('Cookie', adminCookie);
  assert(dealsRes.status === 200, 'GET /api/deals returns deals list');

  const financeRes = await request(app).get('/api/finance/income').set('Cookie', adminCookie);
  assert(financeRes.status === 200, 'GET /api/finance/income returns income report');

  // 2. Visual Gallery Smoke Test
  console.log('\n--- 2. Visual Gallery Smoke Test ---');
  const galleryRes = await request(app).get(`/api/projects/${projectId}/media`).set('Cookie', adminCookie);
  assert(galleryRes.status === 200 && galleryRes.body.data?.media?.length === 9, 'GET /api/projects/3/media returns all 9 visual renders');
  
  const coverItem = galleryRes.body.data?.media?.find(m => m.is_cover);
  assert(coverItem && coverItem.title.includes('Главный фасад'), 'Main facade is marked as cover');
  assert(coverItem.url && coverItem.url.startsWith('http'), 'Cover image has valid signed read URL');

  const extRes = await request(app).get(`/api/projects/${projectId}/media?category=EXTERIOR`).set('Cookie', adminCookie);
  assert(extRes.status === 200 && extRes.body.data?.media?.length === 3, 'Category EXTERIOR returns 3 renders');

  const courtRes = await request(app).get(`/api/projects/${projectId}/media?category=COURTYARD`).set('Cookie', adminCookie);
  assert(courtRes.status === 200 && courtRes.body.data?.media?.length === 3, 'Category COURTYARD returns 3 renders');

  const masterRes = await request(app).get(`/api/projects/${projectId}/media?category=MASTERPLAN`).set('Cookie', adminCookie);
  assert(masterRes.status === 200 && masterRes.body.data?.media?.length === 2, 'Category MASTERPLAN returns 2 renders');

  const commRes = await request(app).get(`/api/projects/${projectId}/media?category=COMMERCIAL`).set('Cookie', adminCookie);
  assert(commRes.status === 200 && commRes.body.data?.media?.length === 1, 'Category COMMERCIAL returns 1 render');

  // 3. 3D Model Smoke Test
  console.log('\n--- 3. 3D Model Smoke Test ---');
  const scenesRes = await request(app).get(`/api/projects/${projectId}/3d-scenes`).set('Cookie', adminCookie);
  assert(scenesRes.status === 200 && scenesRes.body.data?.scenes?.length > 0, 'GET /api/projects/3/3d-scenes returns active 3D scenes');
  
  const activeScene = scenesRes.body.data?.scenes?.find(s => s.is_active);
  assert(activeScene && activeScene.model_url?.startsWith('http'), 'Active 3D scene has signed streamable GLB URL');

  if (activeScene) {
    const batchEntitiesRes = await request(app).get(`/api/3d-scenes/${activeScene.id}/resolved-entities`).set('Cookie', adminCookie);
    assert(batchEntitiesRes.status === 200, 'Batch entity resolution endpoint responds 200 OK');
  }

  // 4. 360 Tour Smoke Test
  console.log('\n--- 4. 360° Tour Smoke Test ---');
  const toursRes = await request(app).get(`/api/projects/${projectId}/360-tours`).set('Cookie', adminCookie);
  assert(toursRes.status === 200, 'GET /api/projects/3/360-tours returns virtual tours');

  // 5. RBAC Enforcement Smoke Test
  console.log('\n--- 5. RBAC Enforcement Smoke Test ---');
  const unauthUploadRes = await request(app)
    .post(`/api/projects/${projectId}/media/upload-url`)
    .set('Cookie', managerCookie)
    .send({ filename: 'unauth.jpg' });
  assert(unauthUploadRes.status === 403, 'SALES_MANAGER mutation attempt correctly blocked with 403 Forbidden');

  const unauth3DRes = await request(app)
    .post(`/api/projects/${projectId}/3d-scenes`)
    .set('Cookie', managerCookie)
    .send({ name: 'Hacked Scene', scene_type: 'BUILDING', storage_path: 'hack.glb' });
  assert(unauth3DRes.status === 403, 'SALES_MANAGER 3D mutation attempt correctly blocked with 403 Forbidden');

  console.log('\n====================================================');
  console.log(`SMOKE TEST RESULT: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

runSmokeTest().catch(err => {
  console.error('Smoke test failure:', err);
  process.exit(1);
});
