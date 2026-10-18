-- Migration 050: Create lead_interested_units table
-- Description: Structured table for tracking apartments shortlisted for CRM leads
-- Mode: LOCAL DEFINITION (Prepared for owner review and future production release. DO NOT APPLY TO PRODUCTION WITHOUT OWNER CONSENT)

BEGIN;

CREATE TABLE IF NOT EXISTS public.lead_interested_units (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    unit_id BIGINT NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
    priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
    comment TEXT,
    next_contact_date DATE,
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_lead_unit_interest UNIQUE (lead_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_interested_units_lead_id ON public.lead_interested_units(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_interested_units_unit_id ON public.lead_interested_units(unit_id);
CREATE INDEX IF NOT EXISTS idx_lead_interested_units_priority ON public.lead_interested_units(priority);

-- Step 2: Safe Idempotent Backfill from existing [UNIT_INTEREST] entries in lead_notes
-- Notes and tasks remain completely intact (0 loss of historical activity log).
DO $$
DECLARE
    note_record RECORD;
    payload JSONB;
    v_unit_id BIGINT;
    v_priority VARCHAR(20);
    v_comment TEXT;
    v_next_contact DATE;
BEGIN
    FOR note_record IN 
        SELECT id, lead_id, body, author_user_id, created_at 
        FROM public.lead_notes 
        WHERE body LIKE '[UNIT_INTEREST] %' OR body LIKE '[UNIT_INTEREST_DELETED] %'
        ORDER BY id ASC
    LOOP
        BEGIN
            IF note_record.body LIKE '[UNIT_INTEREST] %' THEN
                payload := (substring(note_record.body from 16))::jsonb;
                v_unit_id := (payload->>'unit_id')::bigint;
                v_priority := COALESCE(payload->>'priority', 'MEDIUM');
                v_comment := payload->>'comment';
                v_next_contact := (payload->>'next_contact_date')::date;

                IF v_unit_id IS NOT NULL THEN
                    INSERT INTO public.lead_interested_units (
                        lead_id,
                        unit_id,
                        priority,
                        comment,
                        next_contact_date,
                        created_by_user_id,
                        created_at,
                        updated_at
                    ) VALUES (
                        note_record.lead_id,
                        v_unit_id,
                        v_priority,
                        v_comment,
                        v_next_contact,
                        note_record.author_user_id,
                        note_record.created_at,
                        note_record.created_at
                    )
                    ON CONFLICT (lead_id, unit_id) DO UPDATE SET
                        priority = EXCLUDED.priority,
                        comment = EXCLUDED.comment,
                        next_contact_date = EXCLUDED.next_contact_date,
                        updated_at = EXCLUDED.updated_at;
                END IF;
            ELSIF note_record.body LIKE '[UNIT_INTEREST_DELETED] %' THEN
                payload := (substring(note_record.body from 24))::jsonb;
                v_unit_id := (payload->>'unit_id')::bigint;
                IF v_unit_id IS NOT NULL THEN
                    DELETE FROM public.lead_interested_units 
                    WHERE lead_id = note_record.lead_id AND unit_id = v_unit_id;
                END IF;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Skip unparseable legacy notes safely without aborting migration
            RAISE NOTICE 'Skipping unparseable note %: %', note_record.id, SQLERRM;
        END;
    END LOOP;
END $$;

-- Step 3: Security, RLS & PostgREST RBAC Bypass Prevention
ALTER TABLE public.lead_interested_units ENABLE ROW LEVEL SECURITY;

-- Strictly deny direct access to public, anon, and authenticated roles
-- All operations MUST go through the protected Express Backend with strict RBAC
REVOKE ALL ON public.lead_interested_units FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_interested_units_id_seq FROM PUBLIC, anon, authenticated;

-- Grant full access exclusively to backend service_role and postgres superuser
GRANT ALL ON public.lead_interested_units TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.lead_interested_units_id_seq TO service_role, postgres;

-- Policy ensuring service_role full control
DROP POLICY IF EXISTS lead_interested_units_service_role ON public.lead_interested_units;
CREATE POLICY lead_interested_units_service_role ON public.lead_interested_units
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
