import { describe, it, expect } from 'vitest';
import { AzureVisionOCRProvider } from '../ocr/AzureVisionOCRProvider.js';
import { ocrProviderFactory } from '../ocr/ocrProviderFactory.js';
import {
  OCRConfigurationError,
  OCRTimeoutError,
  OCRRateLimitError,
  OCRProviderError
} from '../ocr/ocrErrors.js';

describe('Azure Vision OCR Provider', () => {
  it('correctly reports unconfigured state when credentials are missing', () => {
    const provider = new AzureVisionOCRProvider({ endpoint: '', key: '' });
    expect(provider.isConfigured()).toBe(false);
  });

  it('correctly reports configured state when valid endpoint and key are provided', () => {
    const provider = new AzureVisionOCRProvider({
      endpoint: 'https://tozon-vision.cognitiveservices.azure.com/',
      key: '1234567890abcdef1234567890abcdef'
    });
    expect(provider.isConfigured()).toBe(true);
    expect(provider.providerName).toBe('AZURE_VISION');
  });

  it('throws OCRConfigurationError when trying to recognize without credentials', async () => {
    const provider = new AzureVisionOCRProvider({ endpoint: '', key: '' });
    const dummyBuffer = Buffer.from('fake image content for test');

    await expect(provider.recognizeImage(dummyBuffer)).rejects.toThrow(OCRConfigurationError);
  });

  it('rejects invalid or empty image buffer', async () => {
    const provider = new AzureVisionOCRProvider({
      endpoint: 'https://tozon-vision.cognitiveservices.azure.com/',
      key: '1234567890abcdef1234567890abcdef'
    });

    await expect(provider.recognizeImage(null)).rejects.toThrow(OCRProviderError);
    await expect(provider.recognizeImage(Buffer.from('tiny'))).rejects.toThrow(OCRProviderError);
  });

  it('correctly normalizes Azure Image Analysis v4.0 (2024-02-01) JSON response', () => {
    const provider = new AzureVisionOCRProvider();
    const azureSampleResponse = {
      readResult: {
        blocks: [
          {
            lines: [
              {
                text: 'ШИНОСНОМАИ ШАҲРВАНДИ ҶУМҲУРИИ ТОҶИКИСТОН',
                words: [
                  { text: 'ШИНОСНОМАИ', confidence: 0.98 },
                  { text: 'ШАҲРВАНДИ', confidence: 0.97 },
                  { text: 'ҶУМҲУРИИ', confidence: 0.96 },
                  { text: 'ТОҶИКИСТОН', confidence: 0.99 }
                ]
              },
              {
                text: 'Насаб / Surname: МАЧИДОВ / MAJIDOV',
                words: [
                  { text: 'Насаб', confidence: 0.95 },
                  { text: '/', confidence: 0.99 },
                  { text: 'Surname:', confidence: 0.95 },
                  { text: 'МАЧИДОВ', confidence: 0.99 },
                  { text: '/', confidence: 0.99 },
                  { text: 'MAJIDOV', confidence: 0.99 }
                ]
              },
              {
                text: 'Рақами шиноснома / Document No: A04747883',
                words: [
                  { text: 'Рақами', confidence: 0.95 },
                  { text: 'шиноснома', confidence: 0.95 },
                  { text: 'A04747883', confidence: 0.99 }
                ]
              }
            ]
          }
        ]
      },
      metadata: {
        width: 1200,
        height: 800
      },
      modelVersion: '2024-02-01'
    };

    const normalized = provider.normalizeAzureResponse(azureSampleResponse);

    expect(normalized.provider).toBe('AZURE_VISION');
    expect(normalized.lines.length).toBe(3);
    expect(normalized.lines[0].text).toBe('ШИНОСНОМАИ ШАҲРВАНДИ ҶУМҲУРИИ ТОҶИКИСТОН');
    expect(normalized.lines[1].text).toBe('Насаб / Surname: МАЧИДОВ / MAJIDOV');
    expect(normalized.lines[2].text).toBe('Рақами шиноснома / Document No: A04747883');
    expect(normalized.text).toContain('MAJIDOV');
    expect(normalized.text).toContain('A04747883');
    expect(normalized.confidence).toBeGreaterThan(0.90);
    expect(normalized.metadata.width).toBe(1200);
    expect(normalized.metadata.height).toBe(800);
  });

  it('correctly normalizes Azure Read API v3.2 JSON response', () => {
    const provider = new AzureVisionOCRProvider();
    const azureV32Sample = {
      analyzeResult: {
        version: '3.2',
        readResults: [
          {
            page: 1,
            lines: [
              {
                text: 'IDTJKA0474788353500119825806<<',
                words: [{ text: 'IDTJKA0474788353500119825806<<', confidence: 0.99 }]
              },
              {
                text: '9701078M3301292TJK<<<<<<<<<<<0',
                words: [{ text: '9701078M3301292TJK<<<<<<<<<<<0', confidence: 0.99 }]
              },
              {
                text: 'MAJIDOV<<DILSHOD<<<<<<<<<<<<',
                words: [{ text: 'MAJIDOV<<DILSHOD<<<<<<<<<<<<', confidence: 0.99 }]
              }
            ]
          }
        ]
      }
    };

    const normalized = provider.normalizeAzureResponse(azureV32Sample);

    expect(normalized.provider).toBe('AZURE_VISION');
    expect(normalized.lines.length).toBe(3);
    expect(normalized.text).toContain('IDTJKA04747883');
    expect(normalized.text).toContain('MAJIDOV<<DILSHOD');
    expect(normalized.confidence).toBe(0.99);
  });

  it('ocrProviderFactory returns AzureVisionOCRProvider by default', () => {
    const provider = ocrProviderFactory.getProvider();
    expect(provider).toBeInstanceOf(AzureVisionOCRProvider);
    expect(provider.providerName).toBe('AZURE_VISION');
  });
});
