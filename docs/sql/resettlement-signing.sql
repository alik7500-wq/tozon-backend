-- Apply only after signed legal amendments align each deal amount with the approved allocation.
create table if not exists public.resettlement_deal_signings (
 id bigint generated always as identity primary key,
 case_id bigint not null references public.resettlement_cases(id),
 deal_id integer not null unique references public.deals(id),
 approval_id bigint not null references public.resettlement_allocation_approvals(id),
 signed_document_ref text not null check(length(trim(signed_document_ref))>=3),
 signed_by integer not null,
 signed_at timestamptz not null default now()
);
alter table public.resettlement_deal_signings enable row level security;
revoke all on public.resettlement_deal_signings from public,anon,authenticated;
revoke all on sequence public.resettlement_deal_signings_id_seq from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.sign_resettlement_deal_atomic(p_case_id bigint, p_deal_id integer, p_actor_id integer, p_approval_id bigint, p_signed_document_ref text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c public.resettlement_cases%rowtype; d public.deals%rowtype; a public.resettlement_allocation_approvals%rowtype; u public.units%rowtype; v_count integer;v_total bigint;v_now text;
begin
 if not exists(select 1 from public.users where id=p_actor_id and is_active=1 and role in ('ADMIN','DIRECTOR')) then raise exception 'INVALID_ACTOR'; end if;
 if p_signed_document_ref is null or length(trim(p_signed_document_ref))<3 or length(p_signed_document_ref)>500 then raise exception 'SIGNED_DOCUMENT_REQUIRED'; end if;
 select * into c from public.resettlement_cases where id=p_case_id for update;
 if not found or c.status<>'APPROVED' then raise exception 'CASE_NOT_APPROVED'; end if;
 select * into a from public.resettlement_allocation_approvals where id=p_approval_id and case_id=p_case_id;
 if not found or a.id<>(select max(id) from public.resettlement_allocation_approvals where case_id=p_case_id) then raise exception 'LATEST_APPROVAL_REQUIRED'; end if;
 select count(*),coalesce(sum(allocated_minor),0) into v_count,v_total from public.resettlement_allocation_lines where approval_id=a.id;
 if v_count<>(select count(*) from public.resettlement_case_units where case_id=p_case_id) or v_total<>c.payable_total_minor then raise exception 'ALLOCATION_INTEGRITY_FAILED'; end if;
 if exists(select 1 from public.resettlement_case_units cu join public.deals de on de.id=cu.deal_id join public.resettlement_allocation_lines al on al.deal_id=de.id and al.approval_id=a.id where cu.case_id=p_case_id and (de.currency<>'USD' or de.final_price_minor<>al.allocated_minor)) then raise exception 'CONTRACT_AMENDMENTS_REQUIRED'; end if;
 select de.* into d from public.deals de join public.resettlement_case_units cu on cu.deal_id=de.id and cu.unit_id=de.unit_id where cu.case_id=p_case_id and de.id=p_deal_id for update of de;
 if not found or d.status<>'RESERVED' then raise exception 'DEAL_NOT_RESERVED'; end if;
 select * into u from public.units where id=d.unit_id for update;
 if not found or u.status<>'RESERVED' then raise exception 'UNIT_NOT_RESERVED'; end if;
 v_now:=to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update public.deals set status='SIGNED',signed_at=v_now,updated_at=v_now where id=p_deal_id and status='RESERVED';
 if not found then raise exception 'DEAL_CHANGED'; end if;
 update public.units set status='SOLD',updated_at=v_now where id=d.unit_id and status='RESERVED';
 if not found then raise exception 'UNIT_CHANGED'; end if;
 insert into public.resettlement_deal_signings(case_id,deal_id,approval_id,signed_document_ref,signed_by) values(p_case_id,p_deal_id,p_approval_id,trim(p_signed_document_ref),p_actor_id); update public.leads set status='WON',updated_at=v_now where id=d.lead_id;
 return p_deal_id;
end $function$
;
revoke all on function public.sign_resettlement_deal_atomic(bigint,integer,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.sign_resettlement_deal_atomic(bigint,integer,integer,bigint,text) to service_role;
