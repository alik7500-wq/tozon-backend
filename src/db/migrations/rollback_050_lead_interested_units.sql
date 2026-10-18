-- Rollback 050: Application Safe Revert (Zero Data Loss)
-- Principle: When rolling back the application, DO NOT drop lead_interested_units or delete customer data.
-- 1. Sync any active interests from lead_interested_units into lead_notes as [UNIT_INTEREST] JSON tags,
--    so that the rolled-back application layer (which reads from lead_notes) immediately has full visibility.
-- 2. Preserve public.lead_interested_units and all its records intact.
-- 3. Dropping the table is strictly prohibited here and is relegated to a separate explicit script
--    (purge_050_lead_interested_units_explicit.sql) only after owner verification.

BEGIN;

DO $$
DECLARE
    interest_rec RECORD;
    v_body TEXT;
    v_synced_count INT := 0;
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'lead_interested_units'
    ) THEN
        FOR interest_rec IN 
            SELECT id, lead_id, unit_id, priority, comment, next_contact_date, created_by_user_id, created_at 
            FROM public.lead_interested_units
            ORDER BY id ASC
        LOOP
            v_body := '[UNIT_INTEREST] ' || json_build_object(
                'unit_id', interest_rec.unit_id,
                'priority', interest_rec.priority,
                'comment', COALESCE(interest_rec.comment, ''),
                'next_contact_date', interest_rec.next_contact_date,
                'created_at', interest_rec.created_at,
                'created_by_user_id', interest_rec.created_by_user_id
            )::text;

            -- Check if already present in lead_notes to prevent duplicates
            IF NOT EXISTS (
                SELECT 1 FROM public.lead_notes 
                WHERE lead_id = interest_rec.lead_id 
                  AND (body = v_body OR body LIKE '[UNIT_INTEREST] %"unit_id":' || interest_rec.unit_id || '%')
            ) THEN
                INSERT INTO public.lead_notes (
                    lead_id,
                    author_user_id,
                    body,
                    created_at,
                    updated_at
                ) VALUES (
                    interest_rec.lead_id,
                    interest_rec.created_by_user_id,
                    v_body,
                    interest_rec.created_at,
                    interest_rec.created_at
                );
                v_synced_count := v_synced_count + 1;
            END IF;
        END LOOP;
        
        RAISE NOTICE 'Rollback 050: Synced % interests into lead_notes. Table public.lead_interested_units PRESERVED intact with 0 data loss.', v_synced_count;
    ELSE
        RAISE NOTICE 'Rollback 050: Table public.lead_interested_units does not exist. No sync needed.';
    END IF;
END $$;

-- TABLE PRESERVATION ASSURANCE:
-- Notice: DROP TABLE is intentionally NOT executed here.
-- The table and its records remain intact for zero data loss and safe re-forward migration.

COMMIT;
