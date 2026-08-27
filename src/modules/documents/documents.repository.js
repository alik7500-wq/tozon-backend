import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class DocumentsRepository {
  /**
   * Helper to generate signed read URL from Supabase Storage private bucket
   */
  static async getSignedReadUrl(bucket, storagePath, expiresIn = 3600) {
    if (!storagePath) return null;
    try {
      const db = getDB();
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) {
        console.warn(`[DocumentsRepo] Failed to create signed read URL for ${bucket}/${storagePath}:`, error.message);
        return null;
      }
      return data?.signedUrl || null;
    } catch (err) {
      console.warn(`[DocumentsRepo] Exception creating signed read URL for ${storagePath}:`, err.message);
      return null;
    }
  }

  /**
   * Generate signed upload URL for private bucket identity-documents
   */
  static async generateUploadUrl({ projectId = 1, dealId = 0, leadId = 0, filename, side = 'front', contentType = 'image/jpeg' }) {
    const db = getDB();

    const ext = filename?.split('.').pop()?.toLowerCase();
    const allowed = ['jpg', 'jpeg', 'png', 'pdf'];
    if (!allowed.includes(ext)) {
      throw new AppError('Разрешены только форматы JPG, JPEG, PNG, PDF', 400);
    }

    const sanitized = (filename || 'passport').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `projects/${projectId || 1}/deals/${dealId || 'new'}/passport/${side}_${Date.now()}_${sanitized}`;
    const bucket = 'identity-documents';

    try {
      const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(storagePath);
      if (error) {
        return {
          uploadUrl: `/api/storage/mock-upload/${storagePath}`,
          signedUploadUrl: `/api/storage/mock-upload/${storagePath}`,
          storagePath,
          storage_path: storagePath,
          token: 'mock-token'
        };
      }
      return {
        uploadUrl: data.signedUrl,
        signedUploadUrl: data.signedUrl,
        storagePath: data.path || storagePath,
        storage_path: data.path || storagePath,
        token: data.token
      };
    } catch (err) {
      return {
        uploadUrl: `/api/storage/mock-upload/${storagePath}`,
        signedUploadUrl: `/api/storage/mock-upload/${storagePath}`,
        storagePath,
        storage_path: storagePath,
        token: 'mock-token'
      };
    }
  }

  /**
   * Create new identity document record
   */
  static async create(payload) {
    const db = getDB();

    const insertData = {
      lead_id: payload.lead_id || null,
      deal_id: payload.deal_id || null,
      project_id: payload.project_id || null,
      document_type: payload.document_type || 'PASSPORT_TJ',
      front_image_path: payload.front_image_path || null,
      back_image_path: payload.back_image_path || null,
      ocr_raw_json: payload.ocr_raw_json ? JSON.stringify(payload.ocr_raw_json) : null,
      ocr_fields_json: payload.ocr_fields_json ? JSON.stringify(payload.ocr_fields_json) : null,
      mrz_data_json: payload.mrz_data_json ? JSON.stringify(payload.mrz_data_json) : null,
      confidence_score: payload.confidence_score || 0.0,
      warnings_json: payload.warnings_json ? JSON.stringify(payload.warnings_json) : null,
      status: payload.status || 'REVIEW_REQUIRED',
      verified_data_json: payload.verified_data_json ? JSON.stringify(payload.verified_data_json) : null,
      verified_by_user_id: payload.verified_by_user_id || null,
      verified_at: payload.verified_at || null,
      created_by_user_id: payload.created_by_user_id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await db
      .from('identity_documents')
      .insert(insertData)
      .select('*')
      .single();

    if (error) {
      throw new AppError(`Ошибка сохранения документа: ${error.message}`, 500);
    }

    return this.enrichDocument(data);
  }

  /**
   * Find document by ID
   */
  static async findById(id) {
    const db = getDB();
    const docId = parseInt(id, 10);
    const { data, error } = await db
      .from('identity_documents')
      .select('*')
      .eq('id', docId)
      .maybeSingle();

    if (error || !data) return null;
    return this.enrichDocument(data);
  }

  /**
   * Verify document and update lead record with verified data
   */
  static async verify(id, verifiedData, userId) {
    const db = getDB();
    const docId = parseInt(id, 10);

    const doc = await this.findById(docId);
    if (!doc) throw new AppError('Документ не найден', 404);

    const updatePayload = {
      status: 'VERIFIED',
      verified_data_json: JSON.stringify(verifiedData),
      verified_by_user_id: userId,
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await db
      .from('identity_documents')
      .update(updatePayload)
      .eq('id', docId)
      .select('*')
      .single();

    if (error) {
      throw new AppError(`Ошибка верификации документа: ${error.message}`, 500);
    }

    // Automatically update lead if linked
    if (doc.lead_id) {
      const leadUpdate = {
        full_name: verifiedData.full_name || undefined,
        passport_series: verifiedData.passport_series || undefined,
        passport_number: verifiedData.passport_number || undefined,
        passport_issued_by: verifiedData.passport_issued_by || verifiedData.issuing_authority || undefined,
        passport_issue_date: verifiedData.passport_issue_date || verifiedData.issue_date || undefined,
        birth_date: verifiedData.birth_date || undefined,
        registration_address: verifiedData.registration_address || verifiedData.address || undefined,
        updated_at: new Date().toISOString()
      };

      // Filter out undefined keys
      const cleanUpdate = Object.fromEntries(Object.entries(leadUpdate).filter(([_, v]) => v !== undefined));

      if (Object.keys(cleanUpdate).length > 0) {
        await db.from('leads').update(cleanUpdate).eq('id', doc.lead_id);
      }
    }

    return this.enrichDocument(data);
  }

  /**
   * Delete original scanned images from private storage
   */
  static async deleteImages(id) {
    const db = getDB();
    const docId = parseInt(id, 10);
    const doc = await this.findById(docId);
    if (!doc) throw new AppError('Документ не найден', 404);

    const bucket = 'identity-documents';
    const pathsToDelete = [doc.front_image_path, doc.back_image_path].filter(Boolean);

    if (pathsToDelete.length > 0) {
      await db.storage.from(bucket).remove(pathsToDelete);
    }

    const { data, error } = await db
      .from('identity_documents')
      .update({
        front_image_path: null,
        back_image_path: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', docId)
      .select('*')
      .single();

    if (error) throw new AppError(`Ошибка удаления файлов: ${error.message}`, 500);
    return this.enrichDocument(data);
  }

  /**
   * Enrich document with parsed JSONs and temporary signed read URLs
   */
  static async enrichDocument(doc) {
    if (!doc) return null;

    const bucket = 'identity-documents';
    const [frontSignedUrl, backSignedUrl] = await Promise.all([
      doc.front_image_path ? this.getSignedReadUrl(bucket, doc.front_image_path) : null,
      doc.back_image_path ? this.getSignedReadUrl(bucket, doc.back_image_path) : null
    ]);

    return {
      ...doc,
      front_image_url: frontSignedUrl,
      back_image_url: backSignedUrl,
      ocr_raw: doc.ocr_raw_json ? JSON.parse(doc.ocr_raw_json) : null,
      ocr_fields: doc.ocr_fields_json ? JSON.parse(doc.ocr_fields_json) : null,
      mrz_data: doc.mrz_data_json ? JSON.parse(doc.mrz_data_json) : null,
      warnings: doc.warnings_json ? JSON.parse(doc.warnings_json) : [],
      verified_data: doc.verified_data_json ? JSON.parse(doc.verified_data_json) : null
    };
  }
}
