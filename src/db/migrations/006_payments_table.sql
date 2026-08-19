-- Create payments table for tracking actual payments made against deals and schedules
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    schedule_id INTEGER REFERENCES deal_payment_schedules(id) ON DELETE SET NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    payment_date TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'CASH' CHECK(method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER')),
    reference TEXT,
    comment TEXT,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_deal ON payments(deal_id);
CREATE INDEX IF NOT EXISTS idx_payments_schedule ON payments(schedule_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
