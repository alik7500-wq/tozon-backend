import { AppError } from '../../../shared/errors/errorHandler.js';

export class OCRConfigurationError extends AppError {
  constructor(message = 'OCR Provider is not properly configured') {
    super(message, 500);
    this.name = 'OCRConfigurationError';
    this.code = 'OCR_CONFIG_ERROR';
  }
}

export class OCRTimeoutError extends AppError {
  constructor(message = 'OCR request timed out') {
    super(message, 504);
    this.name = 'OCRTimeoutError';
    this.code = 'OCR_TIMEOUT';
  }
}

export class OCRRateLimitError extends AppError {
  constructor(message = 'OCR provider rate limit exceeded. Please retry shortly.') {
    super(message, 429);
    this.name = 'OCRRateLimitError';
    this.code = 'OCR_RATE_LIMIT';
  }
}

export class OCRProviderError extends AppError {
  constructor(message = 'OCR provider failed to process image', statusCode = 502) {
    super(message, statusCode);
    this.name = 'OCRProviderError';
    this.code = 'OCR_PROVIDER_ERROR';
  }
}
