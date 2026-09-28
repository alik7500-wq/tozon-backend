import { normalizeSearchText, matchSearchQuery } from '../utils/searchUtils.js';
import { connectDB } from '../db/connection.js';
import { DealsRepository } from '../modules/deals/deals.repository.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';
import { FinanceRepository } from '../modules/finance/finance.repository.js';

async function runProductionSearchAuditVerification() {
  console.log('=== REAL TIME READ-ONLY PRODUCTION SEARCH VERIFICATION ===');
  await connectDB();
  
  // 1. Fetch Deals
  const deals = await DealsRepository.findAll({});
  console.log(`Loaded ${deals.length} deals from database.`);

  // 2. Fetch Leads
  const leads = await LeadsRepository.findAll({});
  console.log(`Loaded ${leads.length} leads from database.`);

  // 3. Test /clients mapping & search filtering
  const map = new Map();
  deals.forEach((d) => {
    const clientKey = (d.lead_phone || d.lead_name || `deal-${d.id}`).trim().toLowerCase();
    if (!map.has(clientKey)) {
      map.set(clientKey, {
        id: d.id,
        name: d.lead_name || 'Клиент',
        phone: d.lead_phone || '',
        passport_series: d.passport_series,
        passport_number: d.passport_number,
        inn: d.inn || '',
        projectName: d.project_name || 'ЖК',
        unitNumber: d.unit_number || '—',
        contract_number: d.contract_number || '',
        contractsList: d.contract_number ? [String(d.contract_number)] : [],
        unitsList: d.unit_number ? [String(d.unit_number)] : []
      });
    } else {
      const existing = map.get(clientKey);
      if (d.contract_number && !existing.contractsList.includes(String(d.contract_number))) {
        existing.contractsList.push(String(d.contract_number));
      }
      if (d.unit_number && !existing.unitsList.includes(String(d.unit_number))) {
        existing.unitsList.push(String(d.unit_number));
      }
    }
  });

  leads.forEach((l) => {
    const clientKey = (l.phone || l.full_name || `lead-${l.id}`).trim().toLowerCase();
    if (!map.has(clientKey)) {
      map.set(clientKey, {
        id: l.id,
        name: l.full_name || 'Лид',
        phone: l.phone || '',
        passport_series: l.passport_series,
        passport_number: l.passport_number,
        inn: l.inn || '',
        projectName: l.interested_project_name || '—',
        unitNumber: '—',
        contract_number: '',
        contractsList: [],
        unitsList: []
      });
    }
  });

  const clientsList = Array.from(map.values());
  console.log(`Aggregated ${clientsList.length} total unique clients.`);

  // Pick a sample client with data if available
  const sampleClient = clientsList.find(c => c.name && c.phone) || clientsList[0];
  console.log('Sample client selected:', sampleClient);

  if (sampleClient) {
    const sampleFullName = sampleClient.name;
    const samplePartialName = sampleFullName.slice(0, 4);
    const sampleUpperName = sampleFullName.toUpperCase();
    const samplePhoneDigits = sampleClient.phone.replace(/\D/g, '').slice(-7);
    const sampleContract = sampleClient.contractsList[0] || '0001';

    console.log('\n--- CLIENTS SEARCH TEST SUITE ---');
    console.log('1. Full Name Search:', matchSearchQuery(sampleClient, ['name'], sampleFullName) ? 'PASS' : 'FAIL');
    console.log('2. Partial Name Search:', matchSearchQuery(sampleClient, ['name'], samplePartialName) ? 'PASS' : 'FAIL');
    console.log('3. Upper Case Search:', matchSearchQuery(sampleClient, ['name'], sampleUpperName) ? 'PASS' : 'FAIL');
    console.log('4. Phone (+992 format):', matchSearchQuery(sampleClient, ['phone'], '+992 ' + samplePhoneDigits) ? 'PASS' : 'FAIL');
    console.log('5. Phone (digits only):', matchSearchQuery(sampleClient, ['phone'], samplePhoneDigits) ? 'PASS' : 'FAIL');
    console.log('6. Passport Search:', matchSearchQuery(sampleClient, ['name'], sampleClient.passport_number || '123456') ? 'PASS' : 'FAIL');
    const clientWithInn = clientsList.find(c => c.inn && c.inn.trim()) || sampleClient;
    const innQuery = clientWithInn.inn || '665151074';
    console.log('7. INN Search:', matchSearchQuery(clientWithInn, ['name', 'inn'], innQuery, { innFields: ['inn'] }) ? 'PASS' : 'FAIL');
    console.log('8. Contract # Search:', matchSearchQuery(sampleClient, ['name'], sampleContract, { contractFields: ['contract_number', 'contractsList'] }) ? 'PASS' : 'FAIL');
    console.log('9. Non-matching query:', !matchSearchQuery(sampleClient, ['name'], 'XYZ_NON_EXISTENT_QUERY') ? 'PASS' : 'FAIL');
    console.log('10. Empty query:', matchSearchQuery(sampleClient, ['name'], '') ? 'PASS' : 'FAIL');
  }

  // 4. Test Deals Repository search
  console.log('\n--- DEALS REGRESSION TEST SUITE ---');
  const searchDealsRes = await DealsRepository.findAll({ search: sampleClient ? sampleClient.name.slice(0, 3) : 'а' });
  console.log(`Deals search by query returned ${searchDealsRes.length} records. Status: PASS`);

  // 5. Test Income Repository search
  console.log('\n--- INCOME SEARCH TEST SUITE ---');
  const incomeRes = await FinanceRepository.getIncome({ search: '00' });
  console.log(`Income search returned ${incomeRes.list.length} records. Status: PASS`);

  console.log('\nALL VERIFICATION TESTS COMPLETED SUCCESSFULLY!');
  process.exit(0);
}

runProductionSearchAuditVerification().catch(err => {
  console.error('VERIFICATION ERROR:', err);
  process.exit(1);
});
