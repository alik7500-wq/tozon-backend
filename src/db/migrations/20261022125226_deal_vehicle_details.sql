-- Vehicle handover metadata belongs to the existing contract row and follows its access rules.
-- Existing contracts stay NULL; no financial data, permissions or RLS policies are changed.
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS vehicle_details jsonb
  CONSTRAINT deals_vehicle_details_valid CHECK (
    vehicle_details IS NULL OR (
      jsonb_typeof(vehicle_details) = 'object' AND octet_length(vehicle_details::text) <= 16384
    )
  );
COMMENT ON COLUMN public.deals.vehicle_details IS 'Vehicle handover details entered at sale creation; excludes engine number. Amount remains in barter_amount_minor.';
NOTIFY pgrst, 'reload schema';
