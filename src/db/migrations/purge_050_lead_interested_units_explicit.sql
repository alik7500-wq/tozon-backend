-- Purge 050: Explicit Table Deletion (Manual Destructive Operation)
-- WARNING: This script drops public.lead_interested_units.
-- It MUST ONLY be executed upon explicit written instruction by the project owner
-- after independent verification that all customer interests are safely preserved.

BEGIN;

-- Pre-Drop Safety Assertion:
-- Ensure 100% of rows in lead_interested_units are mirrored in lead_notes before drop.
DO $$
DECLARE
    interest_rec RECORD;
    v_body TEXT;
    v_backed_up INT := 0;
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
                v_backed_up := v_backed_up + 1;
            END IF;
        END LOOP;

        IF v_backed_up > 0 THEN
            RAISE NOTICE 'Purge 050: Pre-drop backup saved % previously unbacked interests into lead_notes.', v_backed_up;
        END IF;

        DROP TABLE public.lead_interested_units CASCADE;
        RAISE NOTICE 'Purge 050: Table public.lead_interested_units successfully dropped after verifying complete data preservation.';
    ELSE
        RAISE NOTICE 'Purge 050: Table public.lead_interested_units does not exist. Nothing to drop.';
    END IF;
END $$;

COMMIT;
