import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { DocumentsRepository } from './documents.repository.js';
import { PassportOCRService } from './passportOcrService.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { getDB } from '../../db/connection.js';

const router = Router();

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
 * Recognize passport scans (Front + Back)
 */
router.post('/passport/recognize', async (req, res, next) => {
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

    let frontInput = frontText || '';
    let backInput = backText || '';

    // If storage paths are provided, fetch file content if available
    const db = getDB();
    if (frontPath && !frontText) {
      try {
        const { data, error } = await db.storage.from('identity-documents').download(frontPath);
        if (!error && data) {
          const buffer = Buffer.from(await data.arrayBuffer());
          frontInput = buffer.toString('utf-8');
        }
      } catch (e) {
        console.warn('Could not read frontPath directly as text:', e.message);
      }
    }

    if (backPath && !backText) {
      try {
        const { data, error } = await db.storage.from('identity-documents').download(backPath);
        if (!error && data) {
          const buffer = Buffer.from(await data.arrayBuffer());
          backInput = buffer.toString('utf-8');
        }
      } catch (e) {
        console.warn('Could not read backPath directly as text:', e.message);
      }
    }

    // Run OCR Recognition Pipeline
    const ocrResult = await PassportOCRService.recognizePassport(frontInput, backInput, { documentType });

    // Save record in database with status REVIEW_REQUIRED
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
      status: 'REVIEW_REQUIRED',
      created_by_user_id: parseOptionalBigInt(req.user?.id) || 1
    });

    res.status(200).json({
      status: 'success',
      data: {
        document: docRecord,
        fields: ocrResult.fields,
        mrz: ocrResult.mrz,
        confidence: ocrResult.confidence,
        warnings: ocrResult.warnings
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/passport/:docId/verify
 * Confirm and verify passport data by manager
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
 * Delete raw scan images under privacy/retention policy
 */
router.delete('/passport/:docId/images', async (req, res, next) => {
  try {
    const cleanDocId = parseRequiredBigInt(req.params.docId, 'docId');
    const updatedDoc = await DocumentsRepository.deleteImages(cleanDocId);

    res.status(200).json({
      status: 'success',
      message: 'Оригиналы изображений успешно удалены',
      data: { document: updatedDoc }
    });
  } catch (err) {
    next(err);
  }
});

export default router;

