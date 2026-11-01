-- DRAFT ONLY. Do not run against production until tenant model and backup are reviewed.
-- Social accounts belong to a CRM tenant, not to an individual employee.
BEGIN;
CREATE TABLE IF NOT EXISTS public.social_channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('INSTAGRAM','WHATSAPP','TELEGRAM')),
  external_account_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONNECTED','EXPIRED','DISCONNECTED','ERROR')),
  -- Only encrypted token material may be persisted here; encryption keys stay outside the database.
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_by_user_id bigint,
  connected_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS social_channel_connections_tenant_status_idx
  ON public.social_channel_connections(tenant_id, status);
ALTER TABLE public.social_channel_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_channel_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_channel_connections TO service_role;
-- The service-role backend MUST enforce tenant membership and admin authorization on every request.
COMMIT;
