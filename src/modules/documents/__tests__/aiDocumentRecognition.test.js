import { describe, it, expect, vi } from 'vitest';
import { parseAndValidateMRZ, computeCheckDigit, verifyCheckDigit } from '../mrzValidator.js';
import { AIDocumentRecognitionService } from '../aiDocumentRecognitionService.js';

describe('AI Passport Scanner V2 — MRZ & Document Analysis', () => {

  describe('MRZ Deterministic Checksum & Parsing', () => {
    it('correctly calculates ICAO 9303 check digit weights', () => {
      // Test string "123456789"
      // Weights: 7, 3, 1, 7, 3, 1, 7, 3, 1
      // (1*7 + 2*3 + 3*1 + 4*7 + 5*3 + 6*1 + 7*7 + 8*3 + 9*1) = 7 + 6 + 3 + 28 + 15 + 6 + 49 + 24 + 9 = 147 % 10 = 7
      const computed = computeCheckDigit('123456789');
      expect(computed).toBe(7);
      expect(verifyCheckDigit('123456789', 7)).toBe(true);
      expect(verifyCheckDigit('123456789', 8)).toBe(false);
    });

    it('correctly parses TD3 (Passport) MRZ lines', () => {
      const line1 = 'P<TJKMURZOEV<<NAIMJON<<<<<<<<<<<<<<<<<<<<<<<';
      const line2 = 'A031957388TJK9001011M3001019<<<<<<<<<<<<<<02';

      const result = parseAndValidateMRZ({ line1, line2 });

      expect(result.format).toBe('TD3');
      expect(result.document_number).toBe('A03195738');
      expect(result.birth_date).toBe('1990-01-01');
      expect(result.expiry_date).toBe('2030-01-01');
      expect(result.sex).toBe('M');
      expect(result.nationality).toBe('TJK');
      expect(result.surname).toBe('MURZOEV');
      expect(result.given_name).toBe('NAIMJON');
      expect(result.document_number_valid).toBe(true);
      expect(result.birth_date_valid).toBe(true);
      expect(result.expiry_date_valid).toBe(true);
    });

    it('handles invalid or empty MRZ input gracefully without crashing', () => {
      const result = parseAndValidateMRZ({ line1: '', line2: '' });
      expect(result.valid).toBe(false);
      expect(result.document_number).toBeNull();
    });
  });

  describe('AI Vision Recognition Service Handling', () => {
    it('returns error if OPENAI_API_KEY is missing', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const dummyBuffer = { buffer: Buffer.from('test'), mimeType: 'image/jpeg' };
      await expect(
        AIDocumentRecognitionService.analyzePassportImages([dummyBuffer])
      ).rejects.toThrow('OPENAI_API_KEY_MISSING');

      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    });
  });

});
