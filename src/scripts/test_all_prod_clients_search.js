import { normalizeSearchText, matchSearchQuery } from '../utils/searchUtils.js';
import { connectDB } from '../db/connection.js';
import { DealsRepository } from '../modules/deals/deals.repository.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';

async function main() {
  await connectDB();
  const deals = await DealsRepository.findAll({});
  const leads = await LeadsRepository.findAll({});

  const map = new Map();

  deals.forEach((d) => {
    const clientKey = (d.lead_phone || d.lead_name || `deal-${d.id}`).trim().toLowerCase();
    if (!map.has(clientKey)) {
      map.set(clientKey, {
        id: `deal-${d.id}`,
        lead_id: d.lead_id,
        deal_id: d.id,
        name: d.lead_name || 'Клиент',
        phone: d.lead_phone || '',
        passport: d.passport_series && d.passport_number ? `${d.passport_series} ${d.passport_number}` : 'Уточняется',
        passport_series: d.passport_series,
        passport_number: d.passport_number,
        inn: d.inn || '',
        address: d.registration_address || 'г. Худжанд',
        dealsCount: 1,
        totalPurchasesMinor: d.final_price_minor || 0,
        totalPaidMinor: d.total_paid_minor || d.paid_amount_minor || 0,
        projectName: d.project_name || 'ЖК',
        unitNumber: d.unit_number || '—',
        contract_number: d.contract_number || '',
        contractsList: d.contract_number ? [String(d.contract_number)] : [],
        unitsList: d.unit_number ? [String(d.unit_number)] : [],
        manager_name: d.manager_name || 'Admin',
        source: 'DEAL',
        status: d.status || 'SIGNED',
        created_at: d.created_at || d.deal_date || new Date().toISOString(),
      });
    } else {
      const existing = map.get(clientKey);
      existing.dealsCount += 1;
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
        id: `lead-${l.id}`,
        lead_id: l.id,
        name: l.full_name || 'Лид',
        phone: l.phone || '',
        passport: l.passport_series && l.passport_number ? `${l.passport_series} ${l.passport_number}` : 'Уточняется',
        passport_series: l.passport_series,
        passport_number: l.passport_number,
        inn: l.inn || '',
        address: l.registration_address || 'г. Худжанд',
        dealsCount: 0,
        totalPurchasesMinor: 0,
        totalPaidMinor: 0,
        projectName: l.interested_project_name || '—',
        unitNumber: '—',
        contract_number: '',
        contractsList: [],
        unitsList: [],
        manager_name: l.responsible_user_name || 'Admin',
        source: l.source || 'DIRECT',
        status: l.status || 'NEW',
        created_at: l.created_at || new Date().toISOString(),
      });
    }
  });

  const clients = Array.from(map.values());
  console.log(`=== LIVE DB PRODUCTION CLIENTS REPORT (${clients.length} TOTAL CLIENTS) ===\n`);

  function testSearch(query) {
    const filtered = clients.filter((c) =>
      matchSearchQuery(
        c,
        ['name', 'phone', 'passport', 'passport_series', 'passport_number', 'inn', 'projectName', 'address'],
        query,
        {
          phoneFields: ['phone'],
          contractFields: ['contract_number', 'contractsList'],
          unitFields: ['unitNumber', 'unitsList'],
          innFields: ['inn']
        }
      )
    );

    console.log(`QUERY: "${query}"`);
    console.log(`  Counter: ${filtered.length}`);
    console.log(`  Rendered Rows Count: ${filtered.length}`);
    if (filtered.length > 0 && filtered.length <= 5) {
      filtered.forEach(f => console.log(`   - Row: [${f.id}] ${f.name} (${f.phone})`));
    }
    console.log('');
  }

  const queries = [
    'ханби',
    'Акмал',
    'АКМАЛХОН',
    'Абдул',
    '+992927797576',
    '927797576',
    '97576',
    '0029',
    '665151074',
    'XYZ_999_NOT_EXIST',
    ''
  ];

  queries.forEach(q => testSearch(q));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
