import { describe, it, expect } from 'vitest';
import { matchSearchQuery, normalizeSearchText } from '../../../utils/searchUtils.js';

describe('Clients Page Search & Key Reconciliation Suite', () => {
  const mockDeals = [
    {
      id: 1,
      lead_id: 10,
      lead_name: 'Ханбиев Рустам',
      lead_phone: '+992927797576',
      passport_series: 'A',
      passport_number: '123456',
      inn: '665151074',
      unit_number: '105',
      contract_number: '25601-2026-0001'
    },
    {
      id: 2,
      lead_id: 11,
      lead_name: 'Махмудов Акмал',
      lead_phone: '+992900000001',
      passport_series: 'B',
      passport_number: '654321',
      inn: '111222333',
      unit_number: '202',
      contract_number: '25601-2026-0002'
    }
  ];

  const mockLeads = [
    {
      id: 1, // Notice lead ID 1 overlaps with deal ID 1
      full_name: 'АКМАЛХОН Каримов',
      phone: '+992920000002',
      passport_series: 'C',
      passport_number: '999888',
      inn: '444555666',
      interested_project_name: 'Somon Residence'
    },
    {
      id: 2,
      full_name: 'Абдуллоев Абдул',
      phone: '+992920000003',
      passport_series: 'D',
      passport_number: '777666',
      inn: '777888999',
      interested_project_name: 'Grand City'
    }
  ];

  function buildMergedClients(deals, leads) {
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
          projectName: d.project_name || 'ЖК',
          unitNumber: d.unit_number || '—',
          contract_number: d.contract_number || '',
          contractsList: d.contract_number ? [String(d.contract_number)] : [],
          unitsList: d.unit_number ? [String(d.unit_number)] : []
        });
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
          projectName: l.interested_project_name || '—',
          unitNumber: '—',
          contract_number: '',
          contractsList: [],
          unitsList: []
        });
      }
    });

    return Array.from(map.values());
  }

  it('1. Guarantees 100% unique React keys (id) across all deals and leads', () => {
    const clients = buildMergedClients(mockDeals, mockLeads);
    const ids = clients.map(c => c.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(4);
    expect(uniqueIds.size).toBe(4);
    expect(ids).toContain('deal-1');
    expect(ids).toContain('lead-1');
  });

  it('2. Filtering by "ханби" returns exactly 1 item and matches rendered row count', () => {
    const clients = buildMergedClients(mockDeals, mockLeads);
    const query = 'ханби';
    const filtered = clients.filter(c => matchSearchQuery(
      c,
      ['name', 'phone', 'passport', 'passport_series', 'passport_number', 'inn', 'projectName', 'address'],
      query,
      {
        phoneFields: ['phone'],
        contractFields: ['contract_number', 'contractsList'],
        unitFields: ['unitNumber', 'unitsList'],
        innFields: ['inn']
      }
    ));

    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe('Ханбиев Рустам');
    expect(filtered[0].id).toBe('deal-1');
  });

  it('3. Filtering by "Акмал" returns matching records correctly', () => {
    const clients = buildMergedClients(mockDeals, mockLeads);
    const query = 'Акмал';
    const filtered = clients.filter(c => matchSearchQuery(
      c,
      ['name', 'phone', 'passport', 'passport_series', 'passport_number', 'inn', 'projectName', 'address'],
      query,
      {
        phoneFields: ['phone'],
        contractFields: ['contract_number', 'contractsList'],
        unitFields: ['unitNumber', 'unitsList'],
        innFields: ['inn']
      }
    ));

    expect(filtered.length).toBe(2);
    expect(filtered.map(f => f.name)).toContain('Махмудов Акмал');
    expect(filtered.map(f => f.name)).toContain('АКМАЛХОН Каримов');
  });

  it('4. Filtering by non-existent query "XYZ_999_NOT_EXIST" returns 0 items', () => {
    const clients = buildMergedClients(mockDeals, mockLeads);
    const query = 'XYZ_999_NOT_EXIST';
    const filtered = clients.filter(c => matchSearchQuery(
      c,
      ['name', 'phone', 'passport', 'passport_series', 'passport_number', 'inn', 'projectName', 'address'],
      query,
      {
        phoneFields: ['phone'],
        contractFields: ['contract_number', 'contractsList'],
        unitFields: ['unitNumber', 'unitsList'],
        innFields: ['inn']
      }
    ));

    expect(filtered.length).toBe(0);
  });
});
