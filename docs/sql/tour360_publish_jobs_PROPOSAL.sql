-- TOZON CRM 360 publication journal — PROPOSAL ONLY; NOT APPLIED.
-- Deploy after reviewing RLS, service-role access, and migration numbering.
create table if not exists public.tour360_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  tour_id bigint not null references public.tours_360(id),
  project_id bigint not null references public.projects(id),
  state text not null default 'PREPARING' check (state in ('PREPARING','COPYING','VERIFYING','ACTIVATING','COMPLETED','FAILED','NEEDS_RECOVERY')),
  manifest jsonb not null default '{}'::jsonb,
  copied_paths jsonb not null default '[]'::jsonb,
  error_code text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists tour360_one_inflight_publish_per_tour
  on public.tour360_publish_jobs(tour_id)
  where state in ('PREPARING','COPYING','VERIFYING','ACTIVATING','NEEDS_RECOVERY');

alter table public.tour360_publish_jobs enable row level security;
revoke all on public.tour360_publish_jobs from anon, authenticated;
-- No anon/authenticated RLS policies. Access via trusted service_role only.
-- Each copied object must be journaled durably BEFORE activation.
-- Publishing must use compare-and-set on tour state, not a blind update.
