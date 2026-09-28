import { getDB } from '../../db/connection.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';

export class DocumentsRepository {
  static async logScanEvent({
    userId,
    clientId,
    eventType,
    documentCountry,
    documentType,
    success,
    model,
    processingDurationMs,
    warningsCount = 0,
    conflictsCount = 0
  }) {
    try {
      const db = getDB();
      const cleanUserId = parseOptionalBigInt(userId);
      const cleanClientId = parseOptionalBigInt(clientId);

      const payload = {
        user_id: cleanUserId,
        client_id: cleanClientId,
        event_type: eventType,
        document_country: documentCountry ? String(documentCountry).substring(0, 10) : null,
        document_type: documentType ? String(documentType).substring(0, 50) : null,
        success: Boolean(success),
        model: model ? String(model).substring(0, 100) : null,
        processing_duration_ms: processingDurationMs ? Math.round(Number(processingDurationMs)) : null,
        warnings_count: warningsCount ? Math.round(Number(warningsCount)) : 0,
        conflicts_count: conflictsCount ? Math.round(Number(conflictsCount)) : 0,
        created_at: new Date().toISOString()
      };

      await db.from('passport_ai_audit_logs').insert([payload]);
    } catch (err) {
      console.error('Failed to save passport AI audit log:', err.message);
      // Non-blocking for primary user flow
    }
  }
}
