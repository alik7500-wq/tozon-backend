-- TOZON CRM only: apply in isolated staging after review.
-- No tenant_id: one Instagram account for the current TOZON deployment.
create table if not exists public.tozon_instagram_oauth_states (
  state_digest text primary key,
  initiated_by text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.tozon_instagram_connections (
  id uuid primary key default gen_random_uuid(),
  instagram_user_id text not null unique,
  username text,
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  status text not null default 'connected'
    check (status in ('connected', 'expired', 'revoked', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tozon_one_active_instagram_connection
  on public.tozon_instagram_connections ((true))
  where status = 'connected';

create index if not exists tozon_instagram_oauth_states_expiry
  on public.tozon_instagram_oauth_states (expires_at);

alter table public.tozon_instagram_oauth_states enable row level security;
alter table public.tozon_instagram_connections enable row level security;
revoke all on public.tozon_instagram_oauth_states from anon, authenticated, public;
revoke all on public.tozon_instagram_connections from anon, authenticated, public;
-- No browser-facing policies. Only trusted server-side service role accesses these.
