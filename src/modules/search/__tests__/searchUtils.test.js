import { describe, it, expect } from 'vitest';
import { normalizeSearchText, extractDigits, matchPhone, matchSearchQuery } from '../../../utils/searchUtils.js';

describe('Search Utility & Normalization Suite', () => {
  it('normalizes search text and handles Tajik Unicode characters properly', () => {
    expect(normalizeSearchText(' Сайфуллозода Сухробхон ')).toBe('сайфуллозода сухробхон');
    expect(normalizeSearchText('ҒАФУРОВҶОН')).toBe('ғафуровҷон');
    expect(normalizeSearchText('ҲАБИБОВ')).toBe('ҳабибов');
    expect(normalizeSearchText(null)).toBe('');
    expect(normalizeSearchText(undefined)).toBe('');
  });

  it('normalizes phone numbers and handles formats (+992, spaces, brackets)', () => {
    expect(extractDigits('+992 (92) 888-07-02')).toBe('992928880702');
    expect(matchPhone('+992 (92) 888-07-02', '928880702')).toBe(true);
    expect(matchPhone('+992 92 888 07 02', '8880702')).toBe(true);
    expect(matchPhone('928880702', '+992928880702')).toBe(true);
    expect(matchPhone('928880702', '123456')).toBe(false);
  });

  it('performs multi-field search matching correctly', () => {
    const clientRecord = {
      name: 'Сайфуллозода Сухробхон',
      phone: '+992 92 888 07 02',
      passport_series: 'А',
      passport_number: '1234567',
      inn: '665151074',
      contract_number: '0006',
      unit_number: '12',
      projectName: 'Somon Residence'
    };

    // 1. Full Name
    expect(matchSearchQuery(clientRecord, ['name'], 'Сайфуллозода Сухробхон')).toBe(true);
    // 2. Partial Name
    expect(matchSearchQuery(clientRecord, ['name'], 'сайф')).toBe(true);
    // 3. Surname
    expect(matchSearchQuery(clientRecord, ['name'], 'Сайфуллозода')).toBe(true);
    // 4. First Name
    expect(matchSearchQuery(clientRecord, ['name'], 'сухроб')).toBe(true);
    // 5. Case insensitivity
    expect(matchSearchQuery(clientRecord, ['name'], 'САЙФ')).toBe(true);
    // 6. Phone full
    expect(matchSearchQuery(clientRecord, ['phone'], '+992 92 888 07 02')).toBe(true);
    // 7. Phone digits only
    expect(matchSearchQuery(clientRecord, ['phone'], '928880702')).toBe(true);
    // 8. Passport
    expect(matchSearchQuery(clientRecord, ['name'], '1234567')).toBe(true);
    // 9. INN
    expect(matchSearchQuery(clientRecord, ['name'], '665151074')).toBe(true);
    // 10. Contract number
    expect(matchSearchQuery(clientRecord, ['name'], '0006')).toBe(true);
    // 11. Apartment unit number
    expect(matchSearchQuery(clientRecord, ['name'], '12')).toBe(true);
    // 12. Non-existent query
    expect(matchSearchQuery(clientRecord, ['name'], 'НесуществующийКлиент')).toBe(false);
    // 13. Empty query
    expect(matchSearchQuery(clientRecord, ['name'], '')).toBe(true);
    // 14. Query with leading/trailing spaces
    expect(matchSearchQuery(clientRecord, ['name'], '  сайф  ')).toBe(true);
    // 15. Tajik Unicode match
    const tajikClient = { name: 'Ғафуров Ҳабиб Ҷомиевич' };
    expect(matchSearchQuery(tajikClient, ['name'], 'ғаф')).toBe(true);
    expect(matchSearchQuery(tajikClient, ['name'], 'ҲАБИБ')).toBe(true);
    expect(matchSearchQuery(tajikClient, ['name'], 'ҷоми')).toBe(true);
  });
});
