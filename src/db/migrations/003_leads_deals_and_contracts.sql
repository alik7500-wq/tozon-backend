CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    secondary_phone TEXT,
    source TEXT DEFAULT 'DIRECT',
    status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION', 'WON', 'LOST')),
    responsible_user_id INTEGER REFERENCES users(id),
    passport_series TEXT,
    passport_number TEXT,
    passport_issued_by TEXT,
    passport_issue_date TEXT,
    birth_date TEXT,
    registration_address TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_number TEXT UNIQUE,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    responsible_user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'RESERVED', 'SIGNED', 'CANCELLED')),
    payment_type TEXT NOT NULL DEFAULT 'FULL' CHECK(payment_type IN ('FULL', 'INSTALLMENT')),
    currency TEXT NOT NULL DEFAULT 'TJS',
    base_price_minor INTEGER NOT NULL CHECK(base_price_minor >= 0),
    discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_minor >= 0),
    final_price_minor INTEGER NOT NULL CHECK(final_price_minor >= 0),
    down_payment_minor INTEGER NOT NULL DEFAULT 0,
    installment_months INTEGER DEFAULT 0,
    reservation_expires_at TEXT,
    deal_date TEXT NOT NULL,
    signed_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Protection against double sales: A unit can only have one active deal (RESERVED or SIGNED)
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_active_unit 
ON deals(unit_id) 
WHERE status IN ('RESERVED', 'SIGNED');

CREATE TABLE IF NOT EXISTS deal_payment_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    payment_number INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    paid_amount_minor INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UPCOMING' CHECK(status IN ('UPCOMING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_unit ON deals(unit_id);
CREATE INDEX IF NOT EXISTS idx_schedules_deal ON deal_payment_schedules(deal_id);
