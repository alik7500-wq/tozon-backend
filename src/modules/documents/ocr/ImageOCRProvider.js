/**
 * Abstract Base Class for Image OCR Providers
 */
export class ImageOCRProvider {
  /**
   * Provider identifier (e.g. 'AZURE_VISION', 'MOCK')
   */
  get providerName() {
    throw new Error('getter providerName must be implemented by subclass');
  }

  /**
   * Core recognition contract
   * @param {Buffer} imageBuffer Binary image buffer (JPEG/PNG)
   * @param {Object} options Options including mimeType, timeoutMs, etc.
   * @returns {Promise<{
   *   provider: string,
   *   text: string,
   *   confidence: number,
   *   lines: Array<{ text: string, confidence: number, boundingPolygon?: Array<number> }>,
   *   words: Array<{ text: string, confidence: number }>,
   *   metadata?: { width?: number, height?: number, format?: string }
   * }>}
   */
  async recognizeImage(imageBuffer, options = {}) {
    throw new Error('Method recognizeImage(imageBuffer, options) must be implemented by subclass');
  }
}
