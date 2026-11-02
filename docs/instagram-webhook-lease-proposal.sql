-- REVIEW-ONLY: do not apply to production until worker tests and Meta rollout checks pass.
-- Existing service_role-only claim RPC; add a claim timestamp for lease expiry.
ALTER TABLE public.tozon_instagram_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_tozon_instagram_webhook_event()
RETURNS public.tozon_instagram_webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE claimed public.tozon_instagram_webhook_events;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM public.tozon_instagram_webhook_events
    WHERE attempts < 5
      AND (
        status = 'pending'
        OR (status = 'failed' AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds'))
        OR (status = 'processing' AND claimed_at < now() - interval '5 minutes')
      )
    ORDER BY received_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.tozon_instagram_webhook_events AS e
  SET status = 'processing',
      attempts = e.attempts + 1,
      claimed_at = now(),
      last_error = NULL
  FROM candidate
  WHERE e.id = candidate.id
  RETURNING e.* INTO claimed;
  RETURN claimed;
END;
$$;

-- SECURITY DEFINER in public must never inherit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION public.claim_tozon_instagram_webhook_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tozon_instagram_webhook_event() TO service_role;

-- With the current application code, successful and failed completion is fenced
-- by (id, status='processing', attempts). After five failed claims the row
-- remains in 'failed' for manual review; do not auto-delete the payload.
-- A worker processing for more than five minutes may be reclaimed, so verify
-- maximum processing time and idempotency before production rollout.
