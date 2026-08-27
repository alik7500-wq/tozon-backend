import { describe, it, expect } from 'vitest';
import { calculateCheckDigit, verifyCheckDigit, parseMRZ, parseMrzDate } from '../mrzParser.js';
import {
  PassportOCRService,
  normalizeDate,
  normalizeName,
  normalizePassportNumber,
  normalizeINN,
  extractFieldsFromText,
  areNamesEquivalent
} from '../passportOcrService.js';

describe('MRZ Parser Engine (ICAO Doc 9303)', () => {
  it('correctly calculates and verifies check digits with 7-3-1 weighting', () => {
    const docNumber = 'A04747883';
    const check = calculateCheckDigit(docNumber);
    expect(check).toBe('5');
    expect(verifyCheckDigit(docNumber, '5')).toBe(true);
    expect(verifyCheckDigit(docNumber, '8')).toBe(false);
  });

  it('correctly parses YYMMDD dates for birth and expiry without century confusion', () => {
    expect(parseMrzDate('970107', false)).toBe('1997-01-07');
    expect(parseMrzDate('900514', false)).toBe('1990-05-14');
    expect(parseMrzDate('050210', false)).toBe('2005-02-10');
    expect(parseMrzDate('330129', true)).toBe('2033-01-29');
    expect(parseMrzDate('invalid')).toBe(null);
  });

  it('parses real TD1 National ID Card (Majidov Dilshod fixture)', () => {
    const line1 = 'IDTJKA0474788353500119825806<<';
    const line2 = '9701078M3301292TJK<<<<<<<<<<<0';
    const line3 = 'MAJIDOV<<DILSHOD<<<<<<<<<<<<';

    const result = parseMRZ([line1, line2, line3]);
    expect(result).not.toBeNull();
    expect(result.format).toBe('TD1');
    expect(result.document_number).toBe('A04747883');
    expect(result.issuing_country).toBe('TJK');
    expect(result.surname).toBe('MAJIDOV');
    expect(result.given_names).toBe('DILSHOD');
    expect(result.birth_date).toBe('1997-01-07');
    expect(result.expiry_date).toBe('2033-01-29');
    expect(result.sex).toBe('MALE');
    expect(result.is_valid).toBe(true);
    expect(result.check_digits.document_number).toBe(true);
    expect(result.check_digits.birth_date).toBe(true);
    expect(result.check_digits.expiry_date).toBe(true);
  });
});

describe('Name Equivalence and Transliteration', () => {
  it('correctly matches Latin and Cyrillic Tajik name variants', () => {
    expect(areNamesEquivalent('MAJIDOV', 'МАЧИДОВ')).toBe(true);
    expect(areNamesEquivalent('MAJIDOV', 'МАҶИДОВ')).toBe(true);
    expect(areNamesEquivalent('DILSHOD', 'ДИЛШОД')).toBe(true);
    expect(areNamesEquivalent('MAJIDOV', 'МУҲАММАДИЗОДА')).toBe(false);
  });
});

describe('Passport OCR End-to-End & Deep Cross-Validation', () => {
  it('correctly processes Majidov Dilshod real passport fixture with 100% field accuracy', async () => {
    const frontText = `
      ШИНОСНОМАИ ШАҲРВАНДИ ҶУМҲУРИИ ТОҶИКИСТОН / PASSPORT OF THE REPUBLIC OF TAJIKISTAN
      Насаб / Surname: МАЧИДОВ / MAJIDOV
      Ном / Given names: ДИЛШОД / DILSHOD
      Номи падар / Father's name: ХАЛИМЧОНОВИЧ / HALIMJONOVICH
      Санаи таваллуд / Date of birth: 07.01.1997
      Санаи додани шиноснома / Date of issue: 30.01.2023
      Муҳлати эътибор / Date of expiry: 29.01.2033
      Мақоми додани шиноснома: ШВКД ДАР НОҲИЯИ БОБОҶОН ҒАФУРОВ / DIA IN B.GAFUROV DISTRICT
      РМА / Tax Payer ID: 636991271
      Суроға / Address: ВИЛОЯТИ СУҒД, БОБОҶОН ҒАФУРОВ, Ҷ. Х. УСМОНОВ, КӮЧАИ Ю. ДАЛОБОЕВ, ҲАВЛИИ 19
      Рақами шиноснома / Document No: A04747883
    `;

    const backText = `
      IDTJKA0474788353500119825806<<
      9701078M3301292TJK<<<<<<<<<<<0
      MAJIDOV<<DILSHOD<<<<<<<<<<<<
    `;

    const result = await PassportOCRService.recognizePassport(frontText, backText);

    expect(result.status).toBe('SUCCESS');
    expect(result.has_critical_conflict).toBe(false);
    expect(result.has_missing_required).toBe(false);
    expect(result.confirmation_blocked).toBe(false);
    expect(result.is_fully_agreed).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.88);

    // Verify all core fields
    expect(result.fields.last_name.value).toBe('Мачидов');
    expect(result.fields.first_name.value).toBe('Дилшод');
    expect(result.fields.middle_name.value).toBe('Халимчонович');
    expect(result.fields.passport_number.value).toBe('04747883');
    expect(result.fields.passport_number.series).toBe('A');
    expect(result.fields.birth_date.value).toBe('1997-01-07');
    expect(result.fields.issue_date.value).toBe('2023-01-30');
    expect(result.fields.expiry_date.value).toBe('2033-01-29');
    expect(result.fields.inn.value).toBe('636991271');
    expect(result.fields.issuing_authority.value).toContain('БОБОҶОН ҒАФУРОВ');
    expect(result.fields.address.value).toContain('ВИЛОЯТИ СУҒД');
  });

  it('detects critical conflict and blocks confirmation when visual text mismatches valid MRZ', async () => {
    const corruptedFront = `
      ШИНОСНОМА
      Насаб: Муҳаммадизода
      Ном: Мирзокарим
      Рақами шиноснома: A 03195738
      Санаи таваллуд: 14.05.1990
    `;

    const validMRZBack = `
      IDTJKA0474788353500119825806<<
      9701078M3301292TJK<<<<<<<<<<<0
      MAJIDOV<<DILSHOD<<<<<<<<<<<<
    `;

    const result = await PassportOCRService.recognizePassport(corruptedFront, validMRZBack);

    expect(result.status).toBe('CRITICAL_CONFLICT');
    expect(result.has_critical_conflict).toBe(true);
    expect(result.confirmation_blocked).toBe(true);
    expect(result.is_fully_agreed).toBe(false);
    expect(result.fields.passport_number.conflict).toBe(true);
    expect(result.fields.birth_date.conflict).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.40);
    expect(result.warnings.some(w => w.includes('критические несовпадения') || w.includes('Критический конфликт'))).toBe(true);
  });

  it('hard-blocks confirmation and sets CRITICAL_MISSING_FIELD when document number is missing', async () => {
    const textWithoutDocNumber = `
      ШИНОСНОМАИ ШАҲРВАНДИ ҶУМҲУРИИ ТОҶИКИСТОН
      Насаб: МАЧИДОВ
      Ном: ДИЛШОД
      Санаи таваллуд: 07.01.1997
    `;

    const result = await PassportOCRService.recognizePassport(textWithoutDocNumber, null);

    expect(result.status).toBe('CRITICAL_MISSING_FIELD');
    expect(result.has_missing_required).toBe(true);
    expect(result.confirmation_blocked).toBe(true);
    expect(result.fields.passport_number.value).toBeNull();
    expect(result.confidence).toBeLessThanOrEqual(0.40);
    expect(result.is_fully_agreed).toBe(false);
    expect(result.warnings.some(w => w.includes('номер паспорта'))).toBe(true);
  });

  it('hard-blocks confirmation and sets CRITICAL_MISSING_FIELD when surname or first name is missing', async () => {
    const textWithoutNames = `
      ШИНОСНОМА
      Рақами шиноснома: A04747883
      Санаи таваллуд: 07.01.1997
    `;

    const result = await PassportOCRService.recognizePassport(textWithoutNames, null);

    expect(result.status).toBe('CRITICAL_MISSING_FIELD');
    expect(result.has_missing_required).toBe(true);
    expect(result.confirmation_blocked).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.40);
  });

  it('detects internal MRZ inconsistency if MRZ is marked valid but document number is absent', async () => {
    const corruptMRZ = `
      IDTJK<<<<<<<<<53500119825806<<
      9701078M3301292TJK<<<<<<<<<<<0
      MAJIDOV<<DILSHOD<<<<<<<<<<<<
    `;

    const result = await PassportOCRService.recognizePassport('', corruptMRZ);
    expect(result.status).not.toBe('SUCCESS');
    expect(result.confirmation_blocked).toBe(true);
  });

  it('returns OCR_FAILED for non-document or empty input', async () => {
    const result = await PassportOCRService.recognizePassport('', '');
    expect(result.status).toBe('OCR_FAILED');
    expect(result.confirmation_blocked).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('correctly handles orientation normalization for 0, 90, 180, and 270 degree inputs', async () => {
    // Preprocessed text extracted from normalized 0°, 90°, 180°, 270° orientation
    const orientationPayloads = [0, 90, 180, 270].map(angle => ({
      angle,
      front: `Насаб: МАЧИДОВ\nНом: ДИЛШОД\nРақами шиноснома: A04747883\nСанаи таваллуд: 07.01.1997`,
      back: `IDTJKA0474788353500119825806<<\n9701078M3301292TJK<<<<<<<<<<<0\nMAJIDOV<<DILSHOD<<<<<<<<<<<<`
    }));

    for (const testCase of orientationPayloads) {
      const res = await PassportOCRService.recognizePassport(testCase.front, testCase.back);
      expect(res.status).toBe('SUCCESS');
      expect(res.fields.passport_number.value).toBe('04747883');
      expect(res.fields.last_name.value).toBe('Мачидов');
      expect(res.fields.first_name.value).toBe('Дилшод');
      expect(res.fields.birth_date.value).toBe('1997-01-07');
    }
  });
});
