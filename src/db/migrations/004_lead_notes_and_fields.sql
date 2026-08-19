CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    author_user_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Add missing columns to leads table if they do not exist
ALTER TABLE leads ADD COLUMN interested_project_id INTEGER REFERENCES projects(id);
ALTER TABLE leads ADD COLUMN desired_rooms INTEGER;
ALTER TABLE leads ADD COLUMN budget_min_minor INTEGER;
ALTER TABLE leads ADD COLUMN budget_max_minor INTEGER;
ALTER TABLE leads ADD COLUMN lost_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id);
