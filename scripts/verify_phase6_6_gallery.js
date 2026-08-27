import { connectDB } from '../src/db/connection.js';
import { app } from '../src/app.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const db = connectDB();

async function verify() {
  console.log('=== VERIFYING PHASE 6.6: PROJECT VISUAL GALLERY ===\n');
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

  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: managerUser } = await db.from('users').select('*').eq('role', 'SALES_MANAGER').limit(1).single();
  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';

  const adminCookie = `jwt=${jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' })}`;
  const managerCookie = managerUser
    ? `jwt=${jwt.sign({ id: managerUser.id, role: managerUser.role }, jwtSecret, { expiresIn: '1h' })}`
    : `jwt=${jwt.sign({ id: 999, role: 'SALES_MANAGER' }, jwtSecret, { expiresIn: '1h' })}`;

  const projectId = 3; // ЖК TOZON PLAZA

  // --- 1. Gallery API Retrieval & Signed URLs ---
  console.log('--- 1. Gallery API Retrieval & Signed URLs ---');
  const listRes = await request(app)
    .get(`/api/projects/${projectId}/media`)
    .set('Cookie', adminCookie);

  assert(listRes.status === 200, 'GET /api/projects/:projectId/media returns 200 OK');
  assert(Array.isArray(listRes.body.data?.media), 'Response contains media array');
  assert(listRes.body.data?.media?.length >= 9, `Contains at least 9 media items (found: ${listRes.body.data?.media?.length})`);
  
  const sample = listRes.body.data?.media?.[0];
  assert(sample && (sample.url || sample.image_url), 'Signed image URL is generated and attached');

  // --- 2. Category Filters ---
  console.log('\n--- 2. Category Filters ---');
  const exteriorRes = await request(app)
    .get(`/api/projects/${projectId}/media?category=EXTERIOR`)
    .set('Cookie', adminCookie);
  
  assert(exteriorRes.status === 200, 'Filter by category=EXTERIOR returns 200');
  assert(exteriorRes.body.data?.media?.every(m => m.category === 'EXTERIOR'), 'All items in response belong to EXTERIOR category');
  assert(exteriorRes.body.data?.media?.length === 3, 'Found 3 EXTERIOR items for ЖК TOZON PLAZA');

  const courtyardRes = await request(app)
    .get(`/api/projects/${projectId}/media?category=COURTYARD`)
    .set('Cookie', adminCookie);
  assert(courtyardRes.body.data?.media?.length === 3, 'Found 3 COURTYARD items for ЖК TOZON PLAZA');

  const masterplanRes = await request(app)
    .get(`/api/projects/${projectId}/media?category=MASTERPLAN`)
    .set('Cookie', adminCookie);
  assert(masterplanRes.body.data?.media?.length === 2, 'Found 2 MASTERPLAN items for ЖК TOZON PLAZA');

  const commercialRes = await request(app)
    .get(`/api/projects/${projectId}/media?category=COMMERCIAL`)
    .set('Cookie', adminCookie);
  assert(commercialRes.body.data?.media?.length === 1, 'Found 1 COMMERCIAL item for ЖК TOZON PLAZA');

  // --- 3. Upload URL Generation & MIME Validation ---
  console.log('\n--- 3. Upload URL Generation & MIME Validation ---');
  const uploadUrlRes = await request(app)
    .post(`/api/projects/${projectId}/media/upload-url`)
    .set('Cookie', adminCookie)
    .send({
      filename: 'render_sunset_view.jpg',
      contentType: 'image/jpeg'
    });

  assert(uploadUrlRes.status === 200, 'POST /api/projects/:projectId/media/upload-url returns 200');
  assert(uploadUrlRes.body.data?.storagePath?.startsWith(`projects/${projectId}/media/`), 'Storage path follows secure projects/{id}/media pattern');

  const invalidMimeRes = await request(app)
    .post(`/api/projects/${projectId}/media/upload-url`)
    .set('Cookie', adminCookie)
    .send({
      filename: 'dangerous_script.exe',
      contentType: 'application/x-msdownload'
    });
  assert(invalidMimeRes.status === 400, 'Invalid file extension / MIME type is rejected (400 Bad Request)');

  // --- 4. Role-Based Access Control (RBAC) ---
  console.log('\n--- 4. Role-Based Access Control (RBAC) ---');
  const managerUploadRes = await request(app)
    .post(`/api/projects/${projectId}/media/upload-url`)
    .set('Cookie', managerCookie)
    .send({ filename: 'test.jpg' });

  assert(managerUploadRes.status === 403, 'Unauthorized staff (SALES_MANAGER) is blocked from upload URL generation (403)');

  const managerCreateRes = await request(app)
    .post(`/api/projects/${projectId}/media`)
    .set('Cookie', managerCookie)
    .send({
      category: 'EXTERIOR',
      title: 'Hacked Media',
      storage_path: 'test.jpg'
    });
  assert(managerCreateRes.status === 403, 'Unauthorized staff (SALES_MANAGER) is blocked from creating media records (403)');

  // --- 5. Media Record Lifecycle (Create, Edit, Cover, Delete) ---
  console.log('\n--- 5. Media Record Lifecycle (Create, Edit, Cover, Delete) ---');
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/media`)
    .set('Cookie', adminCookie)
    .send({
      category: 'INTERIOR',
      title: 'Дизайнерский интерьер 3-комнатной квартиры',
      description: 'Гостиная-кухня с панорамными окнами и чистовой отделкой бизнес-класса.',
      storage_path: `projects/${projectId}/media/test_interior_${Date.now()}.jpg`,
      mime_type: 'image/jpeg',
      sort_order: 10,
      is_cover: false
    });

  assert(createRes.status === 201, 'POST /api/projects/:projectId/media creates new media record (201 Created)');
  const newMediaId = createRes.body.data?.media?.id;
  assert(newMediaId > 0, `Created media ID: ${newMediaId}`);

  // Edit title and category
  const editRes = await request(app)
    .patch(`/api/project-media/${newMediaId}`)
    .set('Cookie', adminCookie)
    .send({
      title: 'Обновленный интерьер премиум',
      category: 'INTERIOR',
      sort_order: 12
    });

  assert(editRes.status === 200, 'PATCH /api/project-media/:id updates metadata (200 OK)');
  assert(editRes.body.data?.media?.title === 'Обновленный интерьер премиум', 'Title was updated successfully');
  assert(editRes.body.data?.media?.sort_order === 12, 'Sort order was updated successfully');

  // Set Cover and verify single-cover uniqueness
  const setCoverRes = await request(app)
    .patch(`/api/project-media/${newMediaId}/set-cover`)
    .set('Cookie', adminCookie);

  assert(setCoverRes.status === 200, 'PATCH /api/project-media/:id/set-cover sets media as project cover');
  assert(setCoverRes.body.data?.media?.is_cover === true, 'Media is now marked as is_cover = true');

  // Verify that previous covers in the project were unset
  const allMediaRes = await request(app)
    .get(`/api/projects/${projectId}/media`)
    .set('Cookie', adminCookie);
  const coverCount = allMediaRes.body.data?.media?.filter(m => m.is_cover).length;
  assert(coverCount === 1, `Exactly one cover image exists for project (found: ${coverCount})`);

  // Delete test item
  const deleteRes = await request(app)
    .delete(`/api/project-media/${newMediaId}`)
    .set('Cookie', adminCookie);
  assert(deleteRes.status === 204, 'DELETE /api/project-media/:id deletes item cleanly (204 No Content)');

  // Reset main facade as cover
  const firstItem = allMediaRes.body.data?.media?.find(m => m.title.includes('Главный фасад'));
  if (firstItem) {
    await request(app)
      .patch(`/api/project-media/${firstItem.id}/set-cover`)
      .set('Cookie', adminCookie);
  }

  // --- 6. Non-regression of 3D, 360 & Core CRM ---
  console.log('\n--- 6. Non-regression of 3D, 360 & Core CRM ---');
  const scenesRes = await request(app)
    .get(`/api/projects/${projectId}/3d-scenes`)
    .set('Cookie', adminCookie);
  assert(scenesRes.status === 200, '3D Scenes endpoint functions without regression');

  const toursRes = await request(app)
    .get(`/api/projects/${projectId}/360-tours`)
    .set('Cookie', adminCookie);
  assert(toursRes.status === 200, '360 Tours endpoint functions without regression');

  const chessboardRes = await request(app)
    .get(`/api/inventory/projects/${projectId}/chessboard`)
    .set('Cookie', adminCookie);
  assert(chessboardRes.status === 200, 'CRM Chessboard endpoint functions without regression');

  console.log(`\n========================================`);
  console.log(`PHASE 6.6 VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

verify().catch(err => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
