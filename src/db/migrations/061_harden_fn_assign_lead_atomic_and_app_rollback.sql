-- =============================================================================
-- Migration 061: Unify fn_assign_lead_atomic overload & harden EXECUTE grants
-- Description:
--   Additive/corrective follow-up to 052 & 060. Does NOT rewrite 060 history.
--   1. Verifies the EXACT 7-arg signature, parameter types, DEFAULT count (>= 3),
--      SECURITY DEFINER, and fixed search_path BEFORE dropping the legacy 6-arg overload.
--      Aborts and rolls back the entire transaction on mismatch (no CASCADE).
--   2. Explicitly revokes EXECUTE on ALL overloads of public.fn_assign_lead_atomic
--      from PUBLIC, anon, authenticated and grants strictly to service_role, postgres.
--   3. Secures BIGSERIAL sequences created in 060.
-- =============================================================================

BEGIN;

-- 1. Verify exact 7-arg hardened overload with defaults before dropping legacy 6-arg overload
DO $$
DECLARE
    v_ok BOOLEAN := FALSE;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_assign_lead_atomic'
          AND p.pronargs = 7
          AND p.pronargdefaults >= 3
          AND p.prosecdef = TRUE
          AND 'search_path=public, pg_temp' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
          AND (
              SELECT array_agg(t::regtype::text ORDER BY ord)
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)
          ) = ARRAY['bigint', 'bigint', 'bigint', 'text', 'integer', 'boolean', 'integer']
    ) INTO v_ok;

    IF NOT v_ok THEN
        RAISE EXCEPTION 'INCOMPATIBLE_FN_ASSIGN_LEAD_ATOMIC_SIGNATURE: hardened 7-arg overload with DEFAULTs and search_path not found; aborting without dropping legacy 6-arg overload.';
    END IF;

    -- Drop ONLY the exact legacy 6-arg signature without CASCADE
    DROP FUNCTION IF EXISTS public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN);
END $$;

-- 2. Revoke EXECUTE from PUBLIC, anon, authenticated on ALL remaining overloads
DO $$
DECLARE
    fn_sig TEXT;
BEGIN
    FOR fn_sig IN
        SELECT p.oid::regprocedure::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_assign_lead_atomic'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn_sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres;', fn_sig);
    END LOOP;
END $$;

-- 3. Secure sequences created by 060
DO $$
DECLARE
    seq_name TEXT;
BEGIN
    FOREACH seq_name IN ARRAY ARRAY[
        'contacts_id_seq',
        'lead_communications_id_seq',
        'lead_stage_history_id_seq',
        'crm_event_outbox_id_seq',
        'crm_automation_rules_id_seq',
        'crm_automation_executions_id_seq',
        'call_ai_analyses_id_seq'
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = seq_name AND c.relkind = 'S'
        ) THEN
            EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated;', seq_name);
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role, postgres;', seq_name);
        END IF;
    END LOOP;
END $$;

COMMIT;
