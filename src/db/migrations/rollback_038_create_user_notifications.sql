-- Rollback Migration 038: Create user_notifications table

-- PRE-LIVE ROLLBACK (Safe before production data accumulation):
DROP TABLE IF EXISTS public.user_notifications CASCADE;

-- POST-LIVE ROLLBACK NOTE:
-- If rolling back post-production release, preserve historical user_notifications data
-- by running column/schema deprecation rather than CASCADE DROP TABLE.
