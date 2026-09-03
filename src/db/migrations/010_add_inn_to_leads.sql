-- 010_add_inn_to_leads.sql
-- Add INN (РМА - Рақами Мушаххаси Андозсупоранда) to leads/buyers

ALTER TABLE leads ADD COLUMN IF NOT EXISTS inn TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_inn ON leads(inn);
