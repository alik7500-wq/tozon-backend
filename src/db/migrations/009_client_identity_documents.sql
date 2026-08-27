-- 009_client_identity_documents.sql
-- Identity documents and Passport OCR storage schema

CREATE TABLE IF NOT EXISTS identity_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    document_type TEXT NOT NULL DEFAULT 'PASSPORT_TJ' CHECK(document_type IN ('PASSPORT_TJ', 'ID_CARD', 'FOREIGN_PASSPORT', 'OTHER')),
    front_image_path TEXT,
    back_image_path TEXT,
    ocr_raw_json TEXT,
    ocr_fields_json TEXT,
    mrz_data_json TEXT,
    confidence_score REAL DEFAULT 0.0,
    warnings_json TEXT,
    status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK(status IN ('REVIEW_REQUIRED', 'VERIFIED', 'REJECTED')),
    verified_data_json TEXT,
    verified_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    verified_at TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_docs_lead ON identity_documents(lead_id);
CREATE INDEX IF NOT EXISTS idx_identity_docs_deal ON identity_documents(deal_id);
CREATE INDEX IF NOT EXISTS idx_identity_docs_status ON identity_documents(status);
