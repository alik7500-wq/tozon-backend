-- Verified against production users.id (integer). Tenant ownership remains unresolved; REVIEW ONLY.
-- REVIEW ONLY: do not apply to production before tenant mapping and authorization review.
-- A single Instagram account/contact pair may have one active manager assignment.
create table if not exists public.tozon_instagram_conversation_assignments (
  id bigint generated always as identity primary key,
  instagram_account_id text not null check (instagram_account_id ~ '^[0-9]{5,30}$'),
  contact_id text not null check (contact_id ~ '^[0-9]{5,30}$'),
  tenant_id text not null check (length(trim(tenant_id)) > 0),
  assigned_user_id integer not null references public.users(id),
  assigned_by_user_id integer not null references public.users(id),
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instagram_account_id, contact_id)
);
create index if not exists tozon_ig_assignments_manager_idx
  on public.tozon_instagram_conversation_assignments (tenant_id, assigned_user_id);
alter table public.tozon_instagram_conversation_assignments enable row level security;
revoke all on public.tozon_instagram_conversation_assignments from anon, authenticated;
revoke all on sequence public.tozon_instagram_conversation_assignments_id_seq from anon, authenticated;
-- No anon/authenticated policies. Only trusted server-side service role may query.
grant select, insert, update, delete on public.tozon_instagram_conversation_assignments to service_role;
grant usage, select on sequence public.tozon_instagram_conversation_assignments_id_seq to service_role;

-- Future AVJ multi-tenant rollout must first create an authoritative tenant registry,
-- map every CRM user and Instagram connection to exactly one tenant, and verify
-- tenant ownership server-side. The tenant_id field here is NOT proof of ownership.
-- Do not enable INSTAGRAM_MANAGER_ACCESS_ENABLED based on this table alone.
