-- PROPOSAL ONLY. DO NOT APPLY TO PRODUCTION BEFORE REVIEW.
-- Requires tour360_publish_jobs_PROPOSAL.sql and service-role-only RPC permissions.
-- This SQL does NOT independently verify Storage files; application must run
-- read-only SHA-256 gate immediately before calling. Storage can still change
-- between verification and commit: private bucket immutability is required.
create or replace function public.tour360_activate_verified_draft(
  p_job_id uuid,
  p_expected_tour_id bigint,
  p_expected_project_id bigint
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.tour360_publish_jobs%rowtype;
  v_tour public.tours_360%rowtype;
begin
  select * into v_job from public.tour360_publish_jobs
  where id = p_job_id for update;
  if not found or v_job.state <> 'ACTIVATING'
     or v_job.tour_id <> p_expected_tour_id
     or v_job.project_id <> p_expected_project_id then
    raise exception 'TOUR360_ACTIVATION_JOB_INVALID';
  end if;

  select * into v_tour from public.tours_360
  where id = v_job.tour_id for update;
  if not found or v_tour.project_id <> v_job.project_id
     or v_tour.is_active is distinct from false then
    raise exception 'TOUR360_ACTIVATION_TOUR_INVALID';
  end if;

  -- The journal's manifest and paths must be present; stronger cryptographic
  -- attestation is a release blocker and is not represented by this SQL.
  if jsonb_typeof(v_job.manifest->'files') <> 'array'
     or jsonb_array_length(v_job.manifest->'files') = 0
     or jsonb_typeof(v_job.copied_paths) <> 'array'
     or jsonb_array_length(v_job.copied_paths) = 0 then
    raise exception 'TOUR360_ACTIVATION_MANIFEST_INVALID';
  end if;

  update public.tours_360 set is_active = true where id = v_tour.id;
  update public.tour360_publish_jobs
    set state = 'COMPLETED', completed_at = now(), updated_at = now()
    where id = v_job.id;
  return true;
end;
$$;

revoke all on function public.tour360_activate_verified_draft(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.tour360_activate_verified_draft(uuid, bigint, bigint) to service_role;
