import { app } from '../src/app.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { connectDB } from '../src/db/connection.js';

const db = connectDB();
const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';

const adminToken = jwt.sign({ id: 1, role: 'ADMIN' }, jwtSecret, { expiresIn: '1h' });
const managerToken = jwt.sign({ id: 3, role: 'SALES_MANAGER' }, jwtSecret, { expiresIn: '1h' });

async function testDealEdit() {
  console.log('=== TESTING ADMIN DEAL EDIT API ===\n');

  // Get sample deal
  const { data: sampleDeal } = await db.from('deals').select('id, deal_date, contract_number').limit(1).single();
  if (!sampleDeal) {
    console.error('No sample deal found to test');
    process.exit(1);
  }

  const dealId = sampleDeal.id;
  const originalDate = sampleDeal.deal_date;
  const originalNumber = sampleDeal.contract_number;
  console.log(`Testing with Deal #${dealId}, current deal_date: ${originalDate}, contract_number: ${originalNumber}`);

  // Test 1: Manager attempt should fail with 403
  console.log('\n1. Testing SALES_MANAGER attempt to PATCH /api/deals/' + dealId);
  const managerRes = await request(app)
    .patch(`/api/deals/${dealId}`)
    .set('Cookie', `jwt=${managerToken}`)
    .send({ deal_date: '2026-08-25' });
  
  console.log('Manager status code:', managerRes.status);
  if (managerRes.status === 403) {
    console.log('[PASS] Manager correctly blocked with 403 Forbidden');
  } else {
    console.error('[FAIL] Expected 403, got:', managerRes.status, managerRes.body);
  }

  // Test 2: Admin patch should succeed
  console.log('\n2. Testing ADMIN PATCH /api/deals/' + dealId);
  const newDate = '2026-08-20';
  const adminRes = await request(app)
    .patch(`/api/deals/${dealId}`)
    .set('Cookie', `jwt=${adminToken}`)
    .send({
      deal_date: newDate,
      contract_number: originalNumber
    });

  console.log('Admin status code:', adminRes.status);
  if (adminRes.status === 200 && adminRes.body?.data?.deal?.deal_date === newDate) {
    console.log('[PASS] Admin successfully updated deal_date to', newDate);
  } else {
    console.error('[FAIL] Expected 200 with updated deal_date, got:', adminRes.status, adminRes.body);
  }

  // Revert back to original date
  await request(app)
    .patch(`/api/deals/${dealId}`)
    .set('Cookie', `jwt=${adminToken}`)
    .send({ deal_date: originalDate });

  console.log('\n[PASS] Reverted test deal back to original date:', originalDate);
  console.log('\n=== ALL DEAL EDIT TESTS PASSED ===');
}

testDealEdit().catch(err => {
  console.error('Fatal error during test:', err);
  process.exit(1);
});
