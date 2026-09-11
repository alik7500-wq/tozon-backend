import { connectDB, getDB } from '../src/db/connection.js';
import { app } from '../src/app.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

async function runVerification() {
  console.log('====================================================');
  console.log('  STAGE B: HTTP ENDPOINTS & SECURITY VERIFICATION');
  console.log('====================================================\n');

  await connectDB();
  const db = getDB();

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';

  const { data: adminUser } = await db.from('users').select('*').eq('role', 'ADMIN').limit(1).single();
  const { data: dadojonUser } = await db.from('users').select('*').eq('id', 3).single();

  const adminToken = jwt.sign({ id: adminUser.id, role: adminUser.role }, jwtSecret, { expiresIn: '1h' });
  const dadojonToken = jwt.sign({ id: dadojonUser.id, role: dadojonUser.role }, jwtSecret, { expiresIn: '1h' });

  const adminCookie = `jwt=${adminToken}`;
  const dadojonCookie = `jwt=${dadojonToken}`;

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

  // 1. Unauthorized Protection Check
  console.log('--- 1. Unauthorized Requests Blocked ---');
  const unauthIncome = await request(app).get('/api/finance/income');
  assert(unauthIncome.status === 401, 'GET /api/finance/income without token returns 401');

  const unauthExpenses = await request(app).get('/api/finance/expenses');
  assert(unauthExpenses.status === 401, 'GET /api/finance/expenses without token returns 401');

  const unauthCashflow = await request(app).get('/api/finance/cashflow');
  assert(unauthCashflow.status === 401, 'GET /api/finance/cashflow without token returns 401');

  // 2. Admin Access (Full view)
  console.log('\n--- 2. Admin Access (HTTP 200 & Full Data) ---');
  const adminIncome = await request(app).get('/api/finance/income').set('Cookie', adminCookie);
  assert(adminIncome.status === 200, 'Admin GET /api/finance/income returns HTTP 200');
  assert(adminIncome.body.data?.list?.length === 71, `Admin sees all 71 active PKO (found: ${adminIncome.body.data?.list?.length})`);

  const adminExpenses = await request(app).get('/api/finance/expenses').set('Cookie', adminCookie);
  assert(adminExpenses.status === 200, 'Admin GET /api/finance/expenses returns HTTP 200');
  assert(adminExpenses.body.data?.list?.length === 130, `Admin sees all 130 active RKO (found: ${adminExpenses.body.data?.list?.length})`);

  const adminCashflow = await request(app).get('/api/finance/cashflow').set('Cookie', adminCookie);
  assert(adminCashflow.status === 200, 'Admin GET /api/finance/cashflow returns HTTP 200');
  const totalCapital = adminCashflow.body.data?.summaryByCurrency?.USD?.netCashflow;
  assert(totalCapital === 25264.01, `Admin sees consolidated capital $25,264.01 USD (found: $${totalCapital})`);

  // 3. Dadojon Isolated Access (HTTP 200 & Isolated Data)
  console.log('\n--- 3. Dadojon Isolated Access (HTTP 200 & Strictly Isolated) ---');
  const dadojonIncome = await request(app).get('/api/finance/income').set('Cookie', dadojonCookie);
  assert(dadojonIncome.status === 200, 'Dadojon GET /api/finance/income returns HTTP 200');
  assert(dadojonIncome.body.data?.list?.length === 0, `Dadojon sees exactly 0 PKO for his personal desk (found: ${dadojonIncome.body.data?.list?.length})`);

  const dadojonExpenses = await request(app).get('/api/finance/expenses').set('Cookie', dadojonCookie);
  assert(dadojonExpenses.status === 200, 'Dadojon GET /api/finance/expenses returns HTTP 200');
  assert(dadojonExpenses.body.data?.list?.length === 0, `Dadojon sees exactly 0 RKO for his personal desk (found: ${dadojonExpenses.body.data?.list?.length})`);

  const dadojonCashflow = await request(app).get('/api/finance/cashflow').set('Cookie', dadojonCookie);
  assert(dadojonCashflow.status === 200, 'Dadojon GET /api/finance/cashflow returns HTTP 200');
  assert(dadojonCashflow.body.data?.cashDesksSummary?.length === 1, `Dadojon sees exactly 1 cash desk in summary (found: ${dadojonCashflow.body.data?.cashDesksSummary?.length})`);
  assert(dadojonCashflow.body.data?.cashDesksSummary[0]?.name.includes('Дадочон'), 'Dadojon cash desk name contains Дадочон');
  assert(dadojonCashflow.body.data?.cashDesksSummary[0]?.balanceUsd === 0, 'Dadojon cash desk balance is $0.00 USD');
  assert(dadojonCashflow.body.data?.cashDesksSummary[0]?.balanceTjs === 0, 'Dadojon cash desk balance is 0.00 TJS');

  // Check company secrets hidden
  assert(dadojonCashflow.body.data?.salesSummary?.totalContractSumUsd === 0, 'Company sales volume is zeroed/hidden from Dadojon');
  assert(dadojonCashflow.body.data?.conversionsSummary?.totalConvertedFromUsd === 0, 'Company conversion volume is zeroed/hidden from Dadojon');

  // 4. Role Spoofing Prevention
  console.log('\n--- 4. Role Spoofing & Manipulation Prevention ---');
  const spoofAttempt = await request(app)
    .get('/api/finance/income?userRole=ADMIN')
    .send({ userRole: 'ADMIN' })
    .set('Cookie', dadojonCookie);
  assert(spoofAttempt.body.data?.list?.length === 0, 'Role spoofing via query/body userRole=ADMIN is completely ignored');

  // 5. Mutation Blocking
  console.log('\n--- 5. Mutation & Deletion Blocking for Manager ---');
  const deleteAttempt = await request(app)
    .delete('/api/finance/income/110')
    .set('Cookie', dadojonCookie);
  assert(deleteAttempt.status === 403, `DELETE /api/finance/income/110 by Dadojon blocked with HTTP 403 (actual: ${deleteAttempt.status})`);

  const transferAttempt = await request(app)
    .post('/api/finance/transfers')
    .send({
      source_cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      destination_cash_desk_id: 'fba621e6-4ebe-4459-8623-19f46d864cc6',
      amount_usd: 100
    })
    .set('Cookie', dadojonCookie);
  assert(transferAttempt.status === 403, `POST /api/finance/transfers by Dadojon blocked with HTTP 403 (actual: ${transferAttempt.status})`);

  console.log('\n====================================================');
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runVerification().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
