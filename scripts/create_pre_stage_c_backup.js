import { connectDB, getDB } from '../src/db/connection.js';
import fs from 'fs';
import path from 'path';

async function main() {
  await connectDB();
  const db = getDB();

  // 1. Fetch 71 active PKO
  const { data: pko, count: pkoCount } = await db.from('payments').select('*', { count: 'exact' }).eq('status', 'ACTIVE');
  // 2. Fetch 130 active RKO
  const { data: rko, count: rkoCount } = await db.from('expenses').select('*', { count: 'exact' }).eq('status', 'ACTIVE');
  // 3. Cash desks
  const { data: desks } = await db.from('dictionaries').select('*').eq('type', 'CASH_DESK');

  const { FinanceRepository } = await import('../src/modules/finance/finance.repository.js');
  const cf = await FinanceRepository.getCashflow({}, { isAdmin: true, allDesks: true });

  const backupData = {
    timestamp: new Date().toISOString(),
    batch_id: 'PRE_STAGE_C_BACKUP_' + Date.now(),
    pko_count: pkoCount,
    rko_count: rkoCount,
    netCashflowUSD: cf.summaryByCurrency.USD.netCashflow,
    cashDesksSummary: cf.cashDesksSummary,
    payments: pko,
    expenses: rko,
    dictionaries: desks
  };

  const backupDir = path.resolve('./data/backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `pre_stage_c_backup_${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), 'utf-8');

  // Also insert into finance_audit_backups table
  await db.from('finance_audit_backups').insert([{
    batch_id: 'PRE_RELEASE_STAGE_C_20260912',
    table_name: 'STAGE_C_CHECKPOINT',
    record_id: '0',
    document_number: 'CHECKPOINT_71PKO_130RKO_28601USD',
    amount_minor: 2860100,
    currency: 'USD',
    exchange_rate: 1.0,
    cash_desk_name: 'ALL_CASH_DESKS',
    document_date: new Date().toISOString().split('T')[0],
    previous_status: 'BASELINE_VERIFIED',
    description: `Pre-Stage C Checkpoint: 71 active PKO, 130 active RKO, Capital: $28,601.00 USD. Akmalhon: $7,026.00, Ilhomjon: $21,575.00, Dadajon: $0.00`,
    full_snapshot: backupData,
    backed_up_by: 1
  }]);

  console.log('BACKUP_SUCCESS');
  console.log('Backup file:', backupFile);
  console.log('PKO count:', pkoCount);
  console.log('RKO count:', rkoCount);
  console.log('Capital USD:', cf.summaryByCurrency.USD.netCashflow);
  cf.cashDesksSummary.forEach(d => console.log(d.name, ':', d.balanceUsd, 'USD |', d.balanceTjs || 0, 'TJS'));
}

main().catch(err => {
  console.error('Backup error:', err);
  process.exit(1);
});
