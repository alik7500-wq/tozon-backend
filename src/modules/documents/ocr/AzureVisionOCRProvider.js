import { ImageOCRProvider } from './ImageOCRProvider.js';
import {
  OCRConfigurationError,
  OCRTimeoutError,
  OCRRateLimitError,
  OCRProviderError
} from './ocrErrors.js';

export class AzureVisionOCRProvider extends ImageOCRProvider {
  constructor(config = {}) {
    super();
    this.endpoint = config.endpoint || process.env.AZURE_VISION_ENDPOINT;
    this.key = config.key || process.env.AZURE_VISION_KEY;
    this.apiVersion = config.apiVersion || process.env.AZURE_VISION_API_VERSION || '2024-02-01';
    this.timeoutMs = config.timeoutMs || 15000;
    this.maxRetries = config.maxRetries || 2;
  }

  get providerName() {
    return 'AZURE_VISION';
  }

  /**
   * Validate that Azure endpoint and key are configured
   */
  isConfigured() {
    return Boolean(this.endpoint && this.key && this.endpoint.startsWith('http') && this.key.length >= 16);
  }

  /**
   * Recognize binary image buffer using Azure Vision Image Analysis Read API
   * @param {Buffer} imageBuffer Raw image bytes (JPEG/PNG)
   * @param {Object} options Options like mimeType, timeoutMs
   */
  async recognizeImage(imageBuffer, options = {}) {
    if (!this.isConfigured()) {
      throw new OCRConfigurationError(
        'Azure Vision OCR is not configured. Please specify AZURE_VISION_ENDPOINT and AZURE_VISION_KEY in server environment.'
      );
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 100) {
      throw new OCRProviderError('Invalid or empty image buffer provided for OCR', 400);
    }

    const timeout = options.timeoutMs || this.timeoutMs;
    const cleanEndpoint = this.endpoint.replace(/\/+$/, '');
    const url = `${cleanEndpoint}/computervision/imageanalysis:analyze?features=read&api-version=${this.apiVersion}`;

    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 500ms, 1000ms
        const delay = Math.pow(2, attempt - 1) * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.key,
            'Content-Type': 'application/octet-stream'
          },
          body: imageBuffer,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
          if (attempt < this.maxRetries) continue;
          throw new OCRRateLimitError('Azure Vision rate limit exceeded. Please retry in a few moments.');
        }

        if (response.status >= 500) {
          if (attempt < this.maxRetries) continue;
          throw new OCRProviderError(`Azure Vision server error (HTTP ${response.status})`, 502);
        }

        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          throw new OCRProviderError(`Azure Vision API returned HTTP ${response.status}: ${errBody}`, 502);
        }

        const data = await response.json();
        return this.normalizeAzureResponse(data);
      } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          throw new OCRTimeoutError(`Azure Vision request timed out after ${timeout}ms`);
        }

        if (err instanceof OCRRateLimitError || err instanceof OCRProviderError || err instanceof OCRConfigurationError) {
          throw err;
        }

        lastError = err;
        if (attempt >= this.maxRetries) {
          throw new OCRProviderError(`Azure Vision network error: ${lastError.message}`, 502);
        }
      }
    }

    throw lastError || new OCRProviderError('Failed to process image through Azure Vision');
  }

  /**
   * Normalize Azure Image Analysis / Read response into unified structure
   * @param {Object} data Raw Azure JSON response
   */
  normalizeAzureResponse(data) {
    const lines = [];
    const words = [];
    let totalConfidence = 0;
    let wordCount = 0;

    // Handle Image Analysis v4.0 / 2024-02-01 format: data.readResult.blocks[].lines[]
    if (data?.readResult?.blocks) {
      for (const block of data.readResult.blocks) {
        if (Array.isArray(block.lines)) {
          for (const line of block.lines) {
            const lineText = (line.text || '').trim();
            if (!lineText) continue;

            let lineConfSum = 0;
            let lineWordCount = 0;

            if (Array.isArray(line.words)) {
              for (const word of line.words) {
                const wText = (word.text || '').trim();
                const wConf = typeof word.confidence === 'number' ? word.confidence : 0.95;
                if (wText) {
                  words.push({ text: wText, confidence: wConf });
                  lineConfSum += wConf;
                  lineWordCount++;
                  totalConfidence += wConf;
                  wordCount++;
                }
              }
            }

            const lineConfidence = lineWordCount > 0 ? lineConfSum / lineWordCount : 0.90;
            lines.push({
              text: lineText,
              confidence: parseFloat(lineConfidence.toFixed(3)),
              boundingPolygon: line.boundingPolygon || null
            });
          }
        }
      }
    } else if (data?.analyzeResult?.readResults) {
      // Handle Computer Vision v3.2 format: data.analyzeResult.readResults[].lines[]
      for (const page of data.analyzeResult.readResults) {
        if (Array.isArray(page.lines)) {
          for (const line of page.lines) {
            const lineText = (line.text || '').trim();
            if (!lineText) continue;

            let lineConfSum = 0;
            let lineWordCount = 0;

            if (Array.isArray(line.words)) {
              for (const word of line.words) {
                const wText = (word.text || '').trim();
                const wConf = typeof word.confidence === 'number' ? word.confidence : 0.95;
                if (wText) {
                  words.push({ text: wText, confidence: wConf });
                  lineConfSum += wConf;
                  lineWordCount++;
                  totalConfidence += wConf;
                  wordCount++;
                }
              }
            }

            const lineConfidence = lineWordCount > 0 ? lineConfSum / lineWordCount : 0.90;
            lines.push({
              text: lineText,
              confidence: parseFloat(lineConfidence.toFixed(3)),
              boundingPolygon: line.boundingBox || null
            });
          }
        }
      }
    }

    const rawText = lines.map((l) => l.text).join('\n');
    const avgConfidence = wordCount > 0 ? totalConfidence / wordCount : lines.length > 0 ? 0.85 : 0.0;

    return {
      provider: this.providerName,
      text: rawText,
      confidence: parseFloat(avgConfidence.toFixed(2)),
      lines,
      words,
      metadata: {
        width: data?.metadata?.width || null,
        height: data?.metadata?.height || null,
        modelVersion: data?.modelVersion || data?.analyzeResult?.version || null
      }
    };
  }
}
