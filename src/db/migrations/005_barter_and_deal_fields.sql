-- Add barter fields to deals
ALTER TABLE deals ADD COLUMN barter_description TEXT;
ALTER TABLE deals ADD COLUMN barter_amount_minor INTEGER DEFAULT 0;

-- Recreate deals table or update check constraint if needed for SQLite
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS deals_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_number TEXT UNIQUE,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    responsible_user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'RESERVED', 'SIGNED', 'CANCELLED')),
    payment_type TEXT NOT NULL DEFAULT 'FULL' CHECK(payment_type IN ('FULL', 'INSTALLMENT', 'BARTER', 'PARTIAL_BARTER')),
    currency TEXT NOT NULL DEFAULT 'TJS',
    base_price_minor INTEGER NOT NULL CHECK(base_price_minor >= 0),
    discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_minor >= 0),
    final_price_minor INTEGER NOT NULL CHECK(final_price_minor >= 0),
    down_payment_minor INTEGER NOT NULL DEFAULT 0,
    installment_months INTEGER DEFAULT 0,
    barter_description TEXT,
    barter_amount_minor INTEGER DEFAULT 0,
    reservation_expires_at TEXT,
    deal_date TEXT NOT NULL,
    signed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO deals_new (
    id, contract_number, lead_id, unit_id, responsible_user_id, status,
    payment_type, currency, base_price_minor, discount_minor, final_price_minor,
    down_payment_minor, installment_months, barter_description, barter_amount_minor,
    reservation_expires_at, deal_date, signed_at, cancelled_at, cancellation_reason,
    created_at, updated_at
)
SELECT 
    id, contract_number, lead_id, unit_id, responsible_user_id, status,
    payment_type, currency, base_price_minor, discount_minor, final_price_minor,
    down_payment_minor, installment_months, barter_description, barter_amount_minor,
    reservation_expires_at, deal_date, signed_at, cancelled_at, cancellation_reason,
    created_at, updated_at
FROM deals;

DROP TABLE deals;
ALTER TABLE deals_new RENAME TO deals;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_active_unit 
ON deals(unit_id) 
WHERE status IN ('RESERVED', 'SIGNED');

CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_unit ON deals(unit_id);

PRAGMA foreign_keys = ON;
