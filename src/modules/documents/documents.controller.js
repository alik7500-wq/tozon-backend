import { AIDocumentRecognitionService } from './aiDocumentRecognitionService.js';
import { DocumentsRepository } from './documents.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per image

export async function analyzePassport(req, res, next) {
  try {
    let files = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      files = req.files;
    } else if (req.file) {
      files = [req.file];
    }

    if (!files || files.length === 0) {
      return next(new AppError('Файлы не загружены. Загрузите хотя бы одно изображение документа.', 400));
    }

    if (files.length > 4) {
      return next(new AppError('Максимальное количество файлов для одного документа — 4.', 400));
    }

    const imageBuffers = [];
    for (const f of files) {
      if (!ALLOWED_MIME_TYPES.includes(f.mimetype)) {
        return next(new AppError(`Неподдерживаемый формат файла (${f.mimetype}). Разрешены JPG, JPEG, PNG, WEBP.`, 400));
      }
      if (f.size > MAX_FILE_SIZE_BYTES) {
        return next(new AppError(`Превышен максимальный размер файла (${Math.round(f.size / 1024 / 1024)}MB). Максимум 10MB.`, 400));
      }
      imageBuffers.push({
        buffer: f.buffer,
        mimeType: f.mimetype
      });
    }

    const userId = req.user?.id || null;
    const clientId = req.body?.client_id || null;

    const result = await AIDocumentRecognitionService.analyzePassportImages(imageBuffers);

    // Audit log scan event
    await DocumentsRepository.logScanEvent({
      userId,
      clientId,
      eventType: 'PASSPORT_AI_SCANNED',
      documentCountry: result.document?.country || null,
      documentType: result.document?.document_type || null,
      success: result.success,
      model: result.model,
      processingDurationMs: result.duration_ms,
      warningsCount: result.warnings?.length || 0,
      conflictsCount: result.conflicts?.length || 0
    });

    if (!result.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'DOCUMENT_QUALITY_UNACCEPTABLE',
          message: result.warnings[0] || 'Изображение документа не соответствует требованиям качества'
        },
        data: {
          quality: result.quality,
          warnings: result.warnings
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        quality: result.quality,
        document: result.document,
        confidence: result.confidence,
        mrz_validation: result.mrz_validation,
        conflicts: result.conflicts,
        warnings: result.warnings,
        threshold: result.threshold_used
      }
    });

  } catch (error) {
    console.error('Passport Recognition Controller Error:', error.message);

    // Audit log failure event if relevant
    await DocumentsRepository.logScanEvent({
      userId: req.user?.id || null,
      clientId: req.body?.client_id || null,
      eventType: 'PASSPORT_AI_FAILED',
      documentCountry: null,
      documentType: null,
      success: false,
      model: process.env.OPENAI_PASSPORT_MODEL || 'gpt-4o',
      processingDurationMs: 0,
      warningsCount: 1,
      conflictsCount: 0
    });

    if (error.message && error.message.includes('OPENAI_API_KEY_MISSING')) {
      return next(new AppError('Сервер распознавания не настроен. Свяжитесь с администратором (OPENAI_API_KEY).', 503));
    }

    return next(new AppError(`Ошибка при распознавании документа: ${error.message}`, 500));
  }
}

export async function confirmPassportScan(req, res, next) {
  try {
    const userId = req.user?.id || null;
    const { client_id, document_country, document_type } = req.body;

    await DocumentsRepository.logScanEvent({
      userId,
      clientId: client_id || null,
      eventType: 'PASSPORT_AI_CONFIRMED',
      documentCountry: document_country || null,
      documentType: document_type || null,
      success: true,
      model: process.env.OPENAI_PASSPORT_MODEL || 'gpt-4o',
      processingDurationMs: 0
    });

    return res.status(200).json({
      success: true,
      data: { message: 'Passport recognition confirmed successfully' }
    });
  } catch (error) {
    return next(error);
  }
}
