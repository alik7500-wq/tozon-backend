-- AVJ CRM social connections: staging-only proposal. Do not apply until tenant model is verified.
-- No public grants; only trusted backend service-role may operate these tables.

create table if not exists public.avj_social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_digest text not null unique,
  tenant_id uuid not null,
  initiated_by text not null,
  provider text not null check (provider in ('instagram', 'whatsapp')),
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.avj_social_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  provider text not null check (provider in ('instagram', 'whatsapp')),
  provider_account_id text not null,
  account_label text,
  encrypted_access_token text not null,
  encryption_key_version integer not null default 1,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_account_id)
);

create index if not exists avj_social_oauth_states_expiry_idx
  on public.avj_social_oauth_states (expires_at);
create index if not exists avj_social_connections_tenant_idx
  on public.avj_social_connections (tenant_id, provider);

alter table public.avj_social_oauth_states enable row level security;
alter table public.avj_social_connections enable row level security;
revoke all on table public.avj_social_oauth_states from anon, authenticated, public;
revoke all on table public.avj_social_connections from anon, authenticated, public;
-- Intentionally no client RLS policies. Backend service-role only.
-- Tenant FK must be added once the commercial CRM tenant table is finalized.
