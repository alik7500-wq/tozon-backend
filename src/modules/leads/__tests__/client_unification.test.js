import { describe, it, expect } from 'vitest';
import { LeadsRepository } from '../leads.repository.js';

describe('Client Modal Creation & Edit Unification Test Suite', () => {

  it('1. Create Lead payload correctly processes all 12 unified client fields', async () => {
    const fullClientPayload = {
      full_name: 'Тестовый Покупатель Унификация',
      phone: '+992920000999',
      secondary_phone: '+992920000888',
      birth_date: '1990-05-15',
      responsible_user_id: 1,
      notes: 'Тестовая заметка при создании',
      passport_series: 'А',
      passport_number: '9876543',
      passport_issued_by: 'ШВКД-1 г. Худжанд',
      passport_issue_date: '2020-01-10',
      inn: '665151099',
      registration_address: 'г. Худжанд, ул. Ленина, д. 45'
    };

    const prepared = LeadsRepository._prepareLeadData(fullClientPayload);

    expect(prepared.full_name).toBe('Тестовый Покупатель Унификация');
    expect(prepared.phone).toBe('+992920000999');
    expect(prepared.secondary_phone).toBe('+992920000888');
    expect(prepared.birth_date).toBe('1990-05-15');
    expect(Number(prepared.responsible_user_id)).toBe(1);
    expect(prepared.notes).toBe('Тестовая заметка при создании');
    expect(prepared.passport_series).toBe('А');
    expect(prepared.passport_number).toBe('9876543');
    expect(prepared.passport_issued_by).toBe('ШВКД-1 г. Худжанд');
    expect(prepared.passport_issue_date).toBe('2020-01-10');
    expect(prepared.inn).toBe('665151099');
    expect(prepared.registration_address).toBe('г. Худжанд, ул. Ленина, д. 45');
  });

  it('2. Empty strings convert to null for optional client fields', async () => {
    const partialPayload = {
      full_name: 'Минимальный Клиент',
      phone: '+992921111222',
      secondary_phone: '',
      passport_series: '',
      passport_number: '',
      passport_issued_by: '',
      passport_issue_date: '',
      birth_date: '',
      registration_address: '',
      inn: '',
      notes: ''
    };

    const prepared = LeadsRepository._prepareLeadData(partialPayload);

    expect(prepared.full_name).toBe('Минимальный Клиент');
    expect(prepared.phone).toBe('+992921111222');
    expect(prepared.secondary_phone).toBeNull();
    expect(prepared.passport_series).toBeNull();
    expect(prepared.passport_number).toBeNull();
    expect(prepared.passport_issued_by).toBeNull();
    expect(prepared.passport_issue_date).toBeNull();
    expect(prepared.birth_date).toBeNull();
    expect(prepared.registration_address).toBeNull();
    expect(prepared.inn).toBeNull();
    expect(prepared.notes).toBeNull();
  });
});
