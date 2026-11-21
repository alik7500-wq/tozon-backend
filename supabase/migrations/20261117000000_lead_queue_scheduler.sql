-- Scheduler opt-in. Historical leads are excluded by immutable cutoff.
-- Apply only after review; do not enable the worker during migration.
create table if not exists public.lead_queue_scheduler_control (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  eligible_from timestamptz not null default '2099-01-01T00:00:00Z',
  lease_until timestamptz,
  lease_token uuid,
  updated_at timestamptz not null default now()
);
insert into public.lead_queue_scheduler_control(id) values (1)
on conflict (id) do nothing;
alter table public.lead_queue_scheduler_control enable row level security;
revoke all on public.lead_queue_scheduler_control from public, anon, authenticated;
grant select on public.lead_queue_scheduler_control to service_role;

create or replace function public.claim_lead_queue_scheduler(p_token uuid, p_lease_seconds integer default 120)
returns timestamptz language plpgsql security definer
set search_path = public
as $$
declare v_cutoff timestamptz;
begin
  if p_token is null or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid scheduler lease';
  end if;
  update public.lead_queue_scheduler_control
     set lease_token = p_token, lease_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = 1 and enabled = true and eligible_from <= now()
     and (lease_until is null or lease_until < now())
  returning eligible_from into v_cutoff;
  return v_cutoff;
end;
$$;
revoke all on function public.claim_lead_queue_scheduler(uuid,integer) from public, anon, authenticated;
grant execute on function public.claim_lead_queue_scheduler(uuid,integer) to service_role;

create or replace function public.release_lead_queue_scheduler(p_token uuid)
returns boolean language plpgsql security definer
set search_path = public
as $$
begin
  update public.lead_queue_scheduler_control
     set lease_token = null, lease_until = null, updated_at = now()
   where id = 1 and lease_token = p_token;
  return found;
end;
$$;
revoke all on function public.release_lead_queue_scheduler(uuid) from public, anon, authenticated;
grant execute on function public.release_lead_queue_scheduler(uuid) to service_role;
