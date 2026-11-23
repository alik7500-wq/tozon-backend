-- Additive schema only; no existing contracts or payments are updated.
create table if not exists public.resettlement_allocation_approvals (
 id bigint generated always as identity primary key,
 case_id bigint not null references public.resettlement_cases(id),
 approval_version integer not null check (approval_version > 0),
 payable_total_minor bigint not null check (payable_total_minor >= 0),
 supporting_document_ref text not null check (length(trim(supporting_document_ref)) > 0),
 approved_by integer not null,
 approved_at timestamptz not null default now(),
 unique(case_id, approval_version)
);
create table if not exists public.resettlement_allocation_lines (
 id bigint generated always as identity primary key,
 approval_id bigint not null references public.resettlement_allocation_approvals(id),
 deal_id integer not null references public.deals(id),
 allocated_minor bigint not null check (allocated_minor >= 0),
 unique(approval_id, deal_id)
);
alter table public.resettlement_allocation_approvals enable row level security;
alter table public.resettlement_allocation_lines enable row level security;
revoke all on public.resettlement_allocation_approvals from anon, authenticated;
revoke all on public.resettlement_allocation_lines from anon, authenticated;
revoke all on sequence public.resettlement_allocation_approvals_id_seq from anon, authenticated;
revoke all on sequence public.resettlement_allocation_lines_id_seq from anon, authenticated;
-- Allocation totals and membership must be validated atomically in a future transactional RPC before writes are enabled.

CREATE OR REPLACE FUNCTION public.approve_resettlement_allocation(p_case_id bigint, p_actor_id integer, p_document_ref text, p_allocations jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ declare v_case public.resettlement_cases%rowtype;v_id bigint;v_total bigint;v_count integer;v_link_count integer;v_version integer; begin  if p_actor_id is null or not exists(select 1 from public.users where id=p_actor_id and is_active=1 and role in ('ADMIN','DIRECTOR')) then raise exception 'INVALID_ACTOR'; end if; if p_document_ref is null or length(trim(p_document_ref))<3 or length(p_document_ref)>500 then raise exception 'INVALID_DOCUMENT_REF'; end if; if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations)<1 or jsonb_array_length(p_allocations)>20 then raise exception 'INVALID_ALLOCATIONS'; end if; select * into v_case from public.resettlement_cases where id=p_case_id for update; if not found then raise exception 'RESETTLEMENT_NOT_FOUND'; end if; if v_case.status<>'APPROVED' then raise exception 'RESETTLEMENT_NOT_APPROVED'; end if; if exists(select 1 from jsonb_array_elements(p_allocations) a where jsonb_typeof(a)<>'object' or (a->>'deal_id') !~ '^[1-9][0-9]*$' or (a->>'allocated_minor') !~ '^(0|[1-9][0-9]*)$') then raise exception 'INVALID_ALLOCATIONS'; end if; select count(*),count(distinct (a->>'deal_id')::integer),sum((a->>'allocated_minor')::bigint) into v_count,v_link_count,v_total from jsonb_array_elements(p_allocations) a; if v_count<>v_link_count or v_total<>v_case.payable_total_minor then raise exception 'ALLOCATION_TOTAL_MISMATCH'; end if; select count(*) into v_link_count from public.resettlement_case_units where case_id=p_case_id; if v_count<>v_link_count or exists(select 1 from public.resettlement_case_units u where u.case_id=p_case_id and not exists(select 1 from jsonb_array_elements(p_allocations) a where (a->>'deal_id')::integer=u.deal_id)) then raise exception 'ALLOCATION_LINK_MISMATCH'; end if; if exists(select 1 from public.resettlement_case_units u left join public.deals d on d.id=u.deal_id where u.case_id=p_case_id and (d.id is null or d.currency<>'USD')) then raise exception 'ALLOCATION_CURRENCY_MISMATCH'; end if; select coalesce(max(approval_version),0)+1 into v_version from public.resettlement_allocation_approvals where case_id=p_case_id; insert into public.resettlement_allocation_approvals(case_id,approval_version,payable_total_minor,supporting_document_ref,approved_by) values(p_case_id,v_version,v_case.payable_total_minor,trim(p_document_ref),p_actor_id) returning id into v_id; insert into public.resettlement_allocation_lines(approval_id,deal_id,allocated_minor) select v_id,(a->>'deal_id')::integer,(a->>'allocated_minor')::bigint from jsonb_array_elements(p_allocations) a; return v_id; end $function$
;
revoke all on function public.approve_resettlement_allocation(bigint,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.approve_resettlement_allocation(bigint,integer,text,jsonb) to service_role;
