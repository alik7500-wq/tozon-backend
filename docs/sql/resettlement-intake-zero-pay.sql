-- Allow full-area compensation with zero payable balance and no schedule.
create or replace function public.create_resettlement_intake_atomic(
 p_project_id integer,p_unit_id integer,p_lead_id integer,p_actor_id integer,
 p_original_home_area_x100 integer,p_compensated_area_x100 integer,p_paid_area_x100 integer,
 p_price_per_m2_minor bigint,p_installment_months integer,p_first_payment_date date,
 p_idempotency_key uuid
) returns jsonb language plpgsql set search_path to 'public','pg_temp' as $$
declare v_unit public.units%rowtype;v_deal integer;v_case bigint;v_total bigint;v_base bigint;
 v_date date;v_day integer;v_month integer;v_now text;v_i integer;v_existing record;v_fingerprint text;
begin
 if not exists(select 1 from public.users where id=p_actor_id and is_active=1 and role in ('ADMIN','DIRECTOR')) then raise exception 'INVALID_ACTOR';end if;
 if p_idempotency_key is null or p_project_id is null or p_unit_id is null or p_lead_id is null or
 p_original_home_area_x100 is null or p_compensated_area_x100 is null or p_paid_area_x100 is null or
 p_price_per_m2_minor is null or p_installment_months is null or p_first_payment_date is null or
 p_original_home_area_x100<0 or p_compensated_area_x100<0 or p_paid_area_x100<0 or
 p_price_per_m2_minor<0 or p_installment_months not between 1 and 120 or
 p_compensated_area_x100<p_original_home_area_x100 then raise exception 'INVALID_INTAKE';end if;
 v_total:=round(p_paid_area_x100::numeric*p_price_per_m2_minor/100);
 if v_total>2147483647 or (v_total>0 and v_total<p_installment_months) then raise exception 'INVALID_TOTAL';end if;
 v_fingerprint:=md5(concat_ws('|',p_project_id,p_unit_id,p_lead_id,p_actor_id,p_original_home_area_x100,p_compensated_area_x100,p_paid_area_x100,p_price_per_m2_minor,p_installment_months,p_first_payment_date));
 perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
 select * into v_existing from public.resettlement_intake_keys where idempotency_key=p_idempotency_key;
 if found then
  if v_existing.request_fingerprint<>v_fingerprint then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('case_id',v_existing.case_id,'deal_id',v_existing.deal_id,'replayed',true);
 end if;
 select * into v_unit from public.units where id=p_unit_id and archived_at is null for update;
 if not found or v_unit.status<>'AVAILABLE' or v_unit.unit_kind<>'APARTMENT' then raise exception 'UNIT_UNAVAILABLE';end if;
 if v_unit.area_m2_x100<>p_compensated_area_x100+p_paid_area_x100 then raise exception 'AREA_MISMATCH';end if;
 if not exists(select 1 from public.floors f join public.sections s on s.id=f.section_id join public.buildings b on b.id=s.building_id join public.projects p on p.id=b.project_id where f.id=v_unit.floor_id and p.id=p_project_id and p.currency='USD') then raise exception 'PROJECT_CURRENCY_MISMATCH';end if;
 if not exists(select 1 from public.leads where id=p_lead_id) then raise exception 'LEAD_NOT_FOUND';end if;
 if exists(select 1 from public.deals where unit_id=p_unit_id and status in ('SIGNED','RESERVED')) or exists(select 1 from public.resettlement_case_units where unit_id=p_unit_id) then raise exception 'ALREADY_ALLOCATED';end if;
 v_now:=to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 insert into public.deals(lead_id,unit_id,responsible_user_id,status,payment_type,currency,base_price_minor,discount_minor,final_price_minor,deal_price_per_m2_minor,down_payment_minor,installment_months,first_payment_date,installment_interval_months,deal_date,created_at,updated_at)
 values(p_lead_id,p_unit_id,p_actor_id,'RESERVED',case when v_total=0 then 'FULL' else 'INSTALLMENT' end,'USD',v_total,0,v_total,p_price_per_m2_minor,0,case when v_total=0 then null else p_installment_months end,case when v_total=0 then null else p_first_payment_date::text end,case when v_total=0 then null else 1 end,current_date::text,v_now,v_now)
 returning id into v_deal;
 v_case:=public.create_resettlement_draft(p_project_id,p_original_home_area_x100,p_compensated_area_x100,p_paid_area_x100,p_price_per_m2_minor,p_actor_id,jsonb_build_array(jsonb_build_object('unit_id',p_unit_id,'deal_id',v_deal)));
 update public.resettlement_cases set payable_total_minor=v_total where id=v_case;
 update public.units set status='RESERVED',updated_at=v_now where id=p_unit_id and status='AVAILABLE';
 if not found then raise exception 'UNIT_CHANGED';end if;
 update public.leads set status='NEGOTIATION',updated_at=v_now where id=p_lead_id;
 v_base:=v_total/p_installment_months;
 v_day:=extract(day from p_first_payment_date);
 if v_total>0 then
 for v_i in 0..p_installment_months-1 loop
  v_date:=date_trunc('month',p_first_payment_date)::date+(v_i||' months')::interval;
  v_date:=v_date+((least(v_day,extract(day from (v_date+interval '1 month - 1 day'))::integer)-1)||' days')::interval;
  insert into public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status,created_at,updated_at)
  values(v_deal,v_i+1,v_date::date::text,case when v_i=p_installment_months-1 then v_total-v_base*(p_installment_months-1) else v_base end,0,'UPCOMING',v_now,v_now);
 end loop;
 end if;
 insert into public.resettlement_intake_keys(idempotency_key,case_id,deal_id,request_fingerprint) values(p_idempotency_key,v_case,v_deal,v_fingerprint);
 return jsonb_build_object('case_id',v_case,'deal_id',v_deal,'payable_total_minor',v_total,'unit_status','RESERVED','deal_status','RESERVED','replayed',false);
end $$;
revoke all on function public.create_resettlement_intake_atomic(integer,integer,integer,integer,integer,integer,integer,bigint,integer,date,uuid) from public,anon,authenticated;
grant execute on function public.create_resettlement_intake_atomic(integer,integer,integer,integer,integer,integer,integer,bigint,integer,date,uuid) to service_role;
