import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { DocumentsRepository } from './documents.repository.js';
import { PassportOCRService } from './passportOcrService.js';
import { ocrProviderFactory } from './ocr/ocrProviderFactory.js';
import { OCRConfigurationError, OCRTimeoutError, OCRRateLimitError, OCRProviderError } from './ocr/ocrErrors.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { getDB } from '../../db/connection.js';

const router = Router();

// Rate limiter for OCR requests (30 requests/min per IP/token)
const ocrRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'OCR_RATE_LIMIT',
      message: 'Слишком много запросов OCR. Пожалуйста, подождите перед повторной попыткой.'
    }
  }
});

// Protect all document endpoints
router.use(protect);

/**
 * POST /api/documents/passport/upload-url
 * Generate private signed upload URL for passport scans
 */
router.post('/passport/upload-url', async (req, res, next) => {
  try {
    const { projectId, dealId, leadId, filename, side } = req.body;
    if (!filename) return next(new AppError('Параметр filename обязателен', 400));

    const data = await DocumentsRepository.generateUploadUrl({
      projectId: parseOptionalBigInt(projectId),
      dealId: parseOptionalBigInt(dealId),
      leadId: parseOptionalBigInt(leadId),
      filename,
      side: side || 'front'
    });

    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/passport/recognize
 * Recognize passport scans using Real Pixels -> Text OCR (Azure Vision) + ICAO MRZ Engine
 */
router.post('/passport/recognize', ocrRateLimiter, async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      frontPath,
      backPath,
      frontText,
      backText,
      projectId,
      dealId,
      leadId,
      documentType = 'PASSPORT_TJ'
    } = req.body;

    let frontInput = (frontText || '').trim();
    let backInput = (backText || '').trim();
    let ocrProviderName = 'DIRECT_TEXT';
    let frontOcrConfidence = null;
    let backOcrConfidence = null;

    const db = getDB();
    const provider = ocrProviderFactory.getProvider();

    // 1. Process Front Image Buffer if image path provided and text is empty
    if (frontPath && !frontInput) {
      try {
        const { data, error } = await db.storage.from('identity-documents').download(frontPath);
        if (error || !data) {
          throw new AppError(`Не удалось загрузить изображение лицевой стороны: ${error?.message || 'Файл не найден'}`, 404);
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        const frontOcrResult = await provider.recognizeImage(buffer, { mimeType: data.type || 'image/jpeg' });
        frontInput = frontOcrResult.text;
        frontOcrConfidence = frontOcrResult.confidence;
        ocrProviderName = frontOcrResult.provider;
      } catch (err) {
        if (err instanceof OCRConfigurationError || err instanceof OCRRateLimitError || err instanceof OCRTimeoutError || err instanceof OCRProviderError) {
          throw err;
        }
        console.warn('[PassportOCR] Front image OCR error:', err.message);
      }
    }

    // 2. Process Back Image Buffer if image path provided and text is empty
    if (backPath && !backInput) {
      try {
        const { data, error } = await db.storage.from('identity-documents').download(backPath);
        if (error || !data) {
          throw new AppError(`Не удалось загрузить изображение оборотной стороны: ${error?.message || 'Файл не найден'}`, 404);
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        const backOcrResult = await provider.recognizeImage(buffer, { mimeType: data.type || 'image/jpeg' });
        backInput = backOcrResult.text;
        backOcrConfidence = backOcrResult.confidence;
        ocrProviderName = backOcrResult.provider;
      } catch (err) {
        if (err instanceof OCRConfigurationError || err instanceof OCRRateLimitError || err instanceof OCRTimeoutError || err instanceof OCRProviderError) {
          throw err;
        }
        console.warn('[PassportOCR] Back image OCR error:', err.message);
      }
    }

    // 3. Run Structured Rule & MRZ Parser
    const ocrResult = await PassportOCRService.recognizePassport(frontInput, backInput, { documentType });

    // Technical duration logging without logging sensitive PII
    const durationMs = Date.now() - startTime;
    console.info(`[PassportOCR] Processed document OCR | provider=${ocrProviderName} | status=${ocrResult.status} | duration=${durationMs}ms`);

    // 4. Save record in database
    const docRecord = await DocumentsRepository.create({
      lead_id: parseOptionalBigInt(leadId),
      deal_id: parseOptionalBigInt(dealId),
      project_id: parseOptionalBigInt(projectId),
      document_type: documentType,
      front_image_path: frontPath || null,
      back_image_path: backPath || null,
      ocr_raw_json: ocrResult.raw,
      ocr_fields_json: ocrResult.fields,
      mrz_data_json: ocrResult.mrz,
      confidence_score: ocrResult.confidence,
      warnings_json: ocrResult.warnings,
      status: ocrResult.status === 'SUCCESS' ? 'REVIEW_REQUIRED' : ocrResult.status,
      created_by_user_id: parseOptionalBigInt(req.user?.id) || 1
    });

    res.status(200).json({
      status: 'success',
      data: {
        document: docRecord,
        status: ocrResult.status,
        has_critical_conflict: ocrResult.has_critical_conflict,
        has_missing_required: ocrResult.has_missing_required,
        missing_required_fields: ocrResult.missing_required_fields,
        confirmation_blocked: ocrResult.confirmation_blocked,
        is_fully_agreed: ocrResult.is_fully_agreed,
        fields: ocrResult.fields,
        mrz: ocrResult.mrz,
        confidence: ocrResult.confidence,
        warnings: ocrResult.warnings,
        ocr: {
          provider: ocrProviderName,
          front_confidence: frontOcrConfidence,
          back_confidence: backOcrConfidence
        }
      }
    });
  } catch (err) {
    if (err instanceof OCRConfigurationError) {
      return res.status(200).json({
        status: 'success',
        data: {
          status: 'OCR_FAILED',
          has_missing_required: true,
          confirmation_blocked: true,
          confidence: 0.0,
          warnings: [
            'Azure Vision OCR не настроен на сервере. Пожалуйста, добавьте AZURE_VISION_ENDPOINT и AZURE_VISION_KEY в .env файл backend или введите данные вручную.'
          ],
          fields: {},
          mrz: null
        }
      });
    }
    next(err);
  }
});

/**
 * POST /api/documents/passport/:docId/verify
 * Confirm and verify passport data by manager (Protected with Backend Contract Guard)
 */
router.post('/passport/:docId/verify', async (req, res, next) => {
  try {
    const cleanDocId = parseRequiredBigInt(req.params.docId, 'docId');
    const { verifiedData } = req.body;

    if (!verifiedData) {
      return next(new AppError('Данные для верификации обязательны', 400));
    }

    const docNum = (verifiedData.passport_number || verifiedData.document_number || '').trim();
    const lastName = (verifiedData.last_name || '').trim();
    const firstName = (verifiedData.first_name || '').trim();
    const fullName = (verifiedData.full_name || `${lastName} ${firstName}`).trim();

    if (!docNum || docNum.length < 5) {
      return next(new AppError('Невозможно верифицировать паспорт: номер паспорта обязателен (минимум 5 символов)', 400));
    }

    if (!lastName || !firstName || !fullName) {
      return next(new AppError('Невозможно верифицировать паспорт: ФИО покупателя обязательно', 400));
    }

    const verifiedDoc = await DocumentsRepository.verify(cleanDocId, verifiedData, parseOptionalBigInt(req.user?.id) || 1);

    res.status(200).json({
      status: 'success',
      message: 'Паспортные данные успешно верифицированы',
      data: { document: verifiedDoc }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/passport/:docId
 * Retrieve passport document details with signed read URLs
 */
router.get('/passport/:docId', async (req, res, next) => {
  try {
    const cleanDocId = parseRequiredBigInt(req.params.docId, 'docId');
    const document = await DocumentsRepository.findById(cleanDocId);
    if (!document) return next(new AppError('Документ не найден', 404));

    res.status(200).json({
      status: 'success',
      data: { document }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/documents/passport/:docId/images
 * Delete raw original scans for GDPR / privacy compliance after deal finalization
 */
router.delete('/passport/:docId/images', async (req, res, next) => {
  try {
    const cleanDocId = parseRequiredBigInt(req.params.docId, 'docId');
    const document = await DocumentsRepository.deleteImages(cleanDocId);

    res.status(200).json({
      status: 'success',
      message: 'Оригинальные изображения паспорта успешно удалены',
      data: { document }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
