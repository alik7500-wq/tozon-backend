import { AzureVisionOCRProvider } from './AzureVisionOCRProvider.js';

class OCRProviderFactory {
  constructor() {
    this._defaultProvider = null;
  }

  /**
   * Get active OCR provider instance
   * @param {string} providerName Optional override (e.g. 'AZURE_VISION')
   */
  getProvider(providerName = null) {
    const target = (providerName || process.env.OCR_PROVIDER || 'AZURE_VISION').toUpperCase();

    switch (target) {
      case 'AZURE_VISION':
      default:
        if (!this._defaultProvider) {
          this._defaultProvider = new AzureVisionOCRProvider();
        }
        return this._defaultProvider;
    }
  }

  /**
   * Reset provider instance (useful for testing)
   */
  reset() {
    this._defaultProvider = null;
  }
}

export const ocrProviderFactory = new OCRProviderFactory();
