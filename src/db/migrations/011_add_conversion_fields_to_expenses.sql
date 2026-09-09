-- 011_add_conversion_fields_to_expenses.sql
-- Add currency exchange rate, USD amount snapshot and conversion expense reference to expenses table

-- 1. Safely add columns if they do not exist
ALTER TABLE expenses 
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS conversion_expense_id INTEGER;

-- 2. Safely add foreign key constraint if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_conversion_expense_id_fkey'
  ) THEN
    ALTER TABLE expenses 
      ADD CONSTRAINT expenses_conversion_expense_id_fkey 
      FOREIGN KEY (conversion_expense_id) REFERENCES expenses(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Safely create index on conversion_expense_id if not exists
CREATE INDEX IF NOT EXISTS idx_expenses_conversion_expense_id 
  ON expenses(conversion_expense_id);

-- 4. Safely add validation check constraints if not exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_exchange_rate_check'
  ) THEN
    ALTER TABLE expenses 
      ADD CONSTRAINT expenses_exchange_rate_check 
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_amount_usd_check'
  ) THEN
    ALTER TABLE expenses 
      ADD CONSTRAINT expenses_amount_usd_check 
      CHECK (amount_usd IS NULL OR amount_usd >= 0);
  END IF;
END $$;

-- 5. Comments on columns
COMMENT ON COLUMN expenses.exchange_rate IS 'Historical snapshot of bank exchange rate applied at expense creation';
COMMENT ON COLUMN expenses.amount_usd IS 'Historical snapshot of expense amount in USD equivalent';
COMMENT ON COLUMN expenses.conversion_expense_id IS 'Reference to the originating currency conversion expense (USD cashout)';
