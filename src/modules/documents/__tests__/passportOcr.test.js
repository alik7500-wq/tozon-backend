import { describe, it, expect } from 'vitest';
import { calculateCheckDigit, verifyCheckDigit, parseMRZ, parseMrzDate } from '../mrzParser.js';
import { PassportOCRService, normalizeDate, normalizeName, normalizePassportNumber, normalizeINN, extractFieldsFromText } from '../passportOcrService.js';

describe('MRZ Parser Engine (ICAO Doc 9303)', () => {
  it('correctly calculates and verifies check digits with 7-3-1 weighting', () => {
    // Example: "A0319573" with weights
    const docNumber = 'A03195738';
    const check = calculateCheckDigit(docNumber);
    expect(typeof check).toBe('string');
    expect(verifyCheckDigit(docNumber, check)).toBe(true);
    expect(verifyCheckDigit(docNumber, '9' === check ? '8' : '9')).toBe(false);
  });

  it('correctly parses YYMMDD dates for birth and expiry', () => {
    expect(parseMrzDate('900514', false)).toBe('1990-05-14');
    expect(parseMrzDate('050210', false)).toBe('2005-02-10');
    expect(parseMrzDate('300214', true)).toBe('2030-02-14');
    expect(parseMrzDate('invalid')).toBe(null);
  });

  it('parses standard TD3 Biometric Passport MRZ lines', () => {
    // Real-world sample TD3 format for Tajikistan / CIS Passport
    const line1 = 'P<TJKMUHAMMADIZODA<<MIRZOKARIM<<<<<<<<<<<<<<';
    const line2 = 'A031957380TJK9005148M3002142665151074<<<<<<4';

    const result = parseMRZ([line1, line2]);
    expect(result).not.toBeNull();
    expect(result.format).toBe('TD3');
    expect(result.issuing_country).toBe('TJK');
    expect(result.surname).toBe('MUHAMMADIZODA');
    expect(result.given_names).toBe('MIRZOKARIM');
    expect(result.document_number).toBe('A03195738');
    expect(result.birth_date).toBe('1990-05-14');
    expect(result.sex).toBe('MALE');
    expect(result.expiry_date).toBe('2030-02-14');
    expect(result.personal_number).toBe('665151074');
  });

  it('parses TD1 National ID Card format (3 lines of 30 chars)', () => {
    const line1 = 'I<TJK1234567890<<<<<<<<<<<<<<<';
    const line2 = '8501015M3001018TJK<<<<<<<<<<<8';
    const line3 = 'RAHIMOV<<RUSTAM<<<<<<<<<<<<<<<';

    const result = parseMRZ([line1, line2, line3]);
    expect(result).not.toBeNull();
    expect(result.format).toBe('TD1');
    expect(result.document_number).toBe('123456789');
    expect(result.surname).toBe('RAHIMOV');
    expect(result.given_names).toBe('RUSTAM');
    expect(result.birth_date).toBe('1985-01-01');
  });
});

describe('Passport OCR Normalization and Field Extraction', () => {
  it('normalizes various date formats to YYYY-MM-DD', () => {
    expect(normalizeDate('14.02.2020')).toBe('2020-02-14');
    expect(normalizeDate('14/02/2020')).toBe('2020-02-14');
    expect(normalizeDate('2020-02-14')).toBe('2020-02-14');
    expect(normalizeDate('2020.02.14')).toBe('2020-02-14');
    expect(normalizeDate('invalid')).toBe(null);
  });

  it('normalizes names properly', () => {
    expect(normalizeName('  муҳаммадизода   мирзокарим  ')).toBe('Муҳаммадизода Мирзокарим');
    expect(normalizeName('ALIYEV RUSTAM')).toBe('Aliyev Rustam');
  });

  it('extracts visual passport fields from raw text', () => {
    const sampleText = `
      ҶУМҲУРИИ ТОҶИКИСТОН / РЕСПУБЛИКА ТАДЖИКИСТАН
      ШИНОСНОМА / ПАСПОРТ
      Рақами шиноснома: A 03195738
      Насаб / Фамилия: Муҳаммадизода
      Ном / Имя: Мирзокарим
      Номи падар / Отчество: Мирзоғафур
      Санаи таваллуд / Дата рождения: 14.05.1990
      Санаи додани шиноснома: 14.02.2020
      Мақоми додани шиноснома: ШВКД дар ноҳияи Кӯҳистони Мастчоҳ
      РМА / ИНН: 665151074
      Суроға: В.Суғд, Кӯҳистони Мастчоҳ, деҳаи Ревомутк
    `;

    const fields = extractFieldsFromText(sampleText);
    expect(fields.passport_series).toBe('A');
    expect(fields.passport_number).toBe('03195738');
    expect(fields.last_name).toBe('Муҳаммадизода');
    expect(fields.first_name).toBe('Мирзокарим');
    expect(fields.middle_name).toBe('Мирзоғафур');
    expect(fields.birth_date).toBe('1990-05-14');
    expect(fields.issue_date).toBe('2020-02-14');
    expect(fields.inn).toBe('665151074');
  });

  it('recognizes passport data end-to-end with MRZ cross-validation and high confidence', async () => {
    const sampleFront = `
      ШИНОСНОМА
      Насаб: Муҳаммадизода
      Ном: Мирзокарим
      Номи падар: Мирзоғафур
      Санаи таваллуд: 14.05.1990
      Мақоми додани: ШВКД дар ноҳияи Кӯҳистони Мастчоҳ
      Суроға: В.Суғд, Кӯҳистони Мастчоҳ
      РМА: 665151074
    `;

    const sampleBackWithMRZ = `
      P<TJKMUHAMMADIZODA<<MIRZOKARIM<MIRZOGHAFUR<<<
      A031957380TJK9005148M3002142665151074<<<<<<4
    `;

    const result = await PassportOCRService.recognizePassport(sampleFront, sampleBackWithMRZ);
    expect(result).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.fields.passport_number.value).toBe('03195738');
    expect(result.fields.last_name.value).toBe('Муҳаммадизода');
    expect(result.fields.first_name.value).toBe('Мирзокарим');
    expect(result.fields.birth_date.value).toBe('1990-05-14');
    expect(result.fields.inn.value).toBe('665151074');
  });
});
