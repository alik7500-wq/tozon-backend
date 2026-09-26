-- Migration 031: Drop single-use RPC function recalculate_deal_schedules_atomic after release completion
-- Security: Clean up catalog to ensure zero unused RPC functions remain exposed in PostgreSQL.

DROP FUNCTION IF EXISTS public.recalculate_deal_schedules_atomic(jsonb);
