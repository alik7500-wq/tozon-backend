-- Migration: 036_ai_passport_audit_logs.sql
-- Description: Create passport_ai_audit_logs table for logging non-PII events for AI Passport Scanner V2

BEGIN;

CREATE TABLE IF NOT EXISTS passport_ai_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    client_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('PASSPORT_AI_SCANNED', 'PASSPORT_AI_CONFIRMED', 'PASSPORT_AI_FAILED')),
    document_country VARCHAR(10),
    document_type VARCHAR(50),
    success BOOLEAN NOT NULL DEFAULT TRUE,
    model VARCHAR(100),
    processing_duration_ms INTEGER,
    warnings_count INTEGER DEFAULT 0,
    conflicts_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passport_ai_logs_user ON passport_ai_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_passport_ai_logs_client ON passport_ai_audit_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_passport_ai_logs_event ON passport_ai_audit_logs(event_type);

COMMIT;
