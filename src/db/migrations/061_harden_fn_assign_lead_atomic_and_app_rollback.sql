-- =============================================================================
-- Migration 061: Unify fn_assign_lead_atomic overload & harden EXECUTE grants
-- Description:
--   Additive/corrective follow-up to 052 & 060. Does NOT rewrite 060 history.
--   Why: 052 created a 6-arg fn_assign_lead_atomic(..., p_is_manual DEFAULT FALSE),
--   and 060 created a 7-arg overload (..., p_expected_version INT DEFAULT NULL).
--   Having both overloads with DEFAULT on the 7th parameter causes PostgreSQL
--   "function is not unique" errors for 6-arg callers (old app version).
--   Fix:
--   1. Drop ONLY the legacy 6-arg overload AFTER ensuring the 7-arg overload
--      (with p_expected_version INT DEFAULT NULL) exists, so both 6-arg (old app)
--      and 7-arg (new app) calls resolve unambiguously to one hardened function.
--   2. Explicitly revoke EXECUTE on ALL overloads of public.fn_assign_lead_atomic
--      from PUBLIC, anon, authenticated and grant strictly to service_role, postgres.
--   3. Secure BIGSERIAL sequences created in 060.
-- =============================================================================

BEGIN;

-- 1. Drop the ambiguous legacy 6-arg overload if the 7-arg overload is present
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_assign_lead_atomic'
          AND p.pronargs = 7
    ) THEN
        DROP FUNCTION IF EXISTS public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN);
    END IF;
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
