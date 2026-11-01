-- Dedicated per-installation sources; external callers never receive a CRM session.
create table if not exists public.crm_lead_integrations (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(name) between 1 and 160),
 source text not null check(source in ('WEBINAR','GOOGLE_FORM','INSTAGRAM','WHATSAPP','IMPORT')),
 campaign text not null check(length(campaign) between 1 and 160),
 project_id integer references public.projects(id),
 manager_id integer references public.users(id),
 token_hash text not null,
 is_active boolean not null default true,
 created_by integer not null references public.users(id),
 created_at timestamptz not null default now(),
 last_received_at timestamptz
);
create table if not exists public.crm_lead_inquiries (
 id bigint generated always as identity primary key,
 scope text not null,
 external_key text not null,
 integration_id uuid references public.crm_lead_integrations(id),
 lead_id integer references public.leads(id) on delete set null,
 source text not null,
 campaign text not null,
 submitted_at text,
 outcome text not null check(outcome in ('CREATED','REPEAT','ARCHIVED','AMBIGUOUS')),
 created_by integer references public.users(id),
 created_at timestamptz not null default now(),
 unique(scope,external_key)
);
create index if not exists crm_lead_inquiries_integration_idx on public.crm_lead_inquiries(integration_id,created_at desc);
alter table public.crm_lead_integrations enable row level security;
alter table public.crm_lead_inquiries enable row level security;
revoke all on public.crm_lead_integrations,public.crm_lead_inquiries from public,anon,authenticated,service_role;
revoke all on sequence public.crm_lead_inquiries_id_seq from public,anon,authenticated,service_role;
grant select,insert,update on public.crm_lead_integrations to service_role;
grant select,insert on public.crm_lead_inquiries to service_role;
grant usage,select on sequence public.crm_lead_inquiries_id_seq to service_role;

create or replace function public.crm_intake_phone(p_value text) returns text
language sql immutable strict set search_path = public as $$
 with cleaned as (select regexp_replace(p_value,'[^0-9]','','g') as n),
 normalized as (select case when left(n,2)='00' then substr(n,3) else n end as n from cleaned)
 select case when length(n)=9 then '992'||n else n end from normalized;
$$;
revoke all on function public.crm_intake_phone(text) from public,anon,authenticated;
grant execute on function public.crm_intake_phone(text) to service_role;

create or replace function public.crm_intake_matches(p_phones text[]) returns jsonb
language sql stable set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'phone',crm_intake_phone(phone),'secondary_phone',crm_intake_phone(secondary_phone),'full_name',full_name,'archived',archived_at is not null)), '[]'::jsonb)
 from public.leads where crm_intake_phone(phone)=any(p_phones) or crm_intake_phone(secondary_phone)=any(p_phones);
$$;
revoke all on function public.crm_intake_matches(text[]) from public,anon,authenticated;
grant execute on function public.crm_intake_matches(text[]) to service_role;

-- SECURITY INVOKER: exclusively callable by the trusted backend service role.
-- Each row is a single transaction: inquiry + lead/note + task all commit together.
create or replace function public.crm_intake_lead(p_scope text,p_key text,p_lead jsonb,p_settings jsonb,p_actor integer,p_integration uuid default null) returns jsonb
language plpgsql set search_path = public as $$
declare
 v_config public.crm_lead_integrations%rowtype;
 v_settings jsonb := p_settings;
 v_actor integer := p_actor;
 v_phone text := public.crm_intake_phone(p_lead->>'phone');
 v_record public.crm_lead_inquiries%rowtype;
 v_lead public.leads%rowtype;
 v_count integer;
 v_outcome text;
 v_manager integer;
 v_project integer;
 v_note text;
 v_task_title text;
 v_now text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_task_id integer;
begin
 if length(p_scope)>100 or length(p_key)>128 or p_scope is null or p_key is null or length(p_key)=0 then raise exception 'Invalid inquiry key';end if;
 if p_integration is not null then
   select * into v_config from public.crm_lead_integrations where id=p_integration and is_active for update;
   if not found then raise exception 'Integration inactive';end if;
   v_settings=jsonb_build_object('source',v_config.source,'campaign',v_config.campaign,'manager_id',v_config.manager_id,'project_id',v_config.project_id);
   v_actor=v_config.created_by;
 end if;
 if coalesce(p_lead->>'full_name','')='' or v_phone !~ '^[1-9][0-9]{6,14}$' or v_phone is null then raise exception 'Invalid lead';end if;
 if v_settings->>'source' not in ('WEBINAR','GOOGLE_FORM','INSTAGRAM','WHATSAPP','IMPORT') or coalesce(v_settings->>'campaign','')='' then raise exception 'Invalid settings';end if;
 perform pg_advisory_xact_lock(hashtextextended('intake-key:'||p_scope||':'||p_key,0));
 select * into v_record from public.crm_lead_inquiries where scope=p_scope and external_key=p_key;
 if found then return jsonb_build_object('outcome','DUPLICATE','original_outcome',v_record.outcome,'lead_id',v_record.lead_id);end if;
 perform pg_advisory_xact_lock(hashtextextended('intake-phone:'||v_phone,0));
 v_manager=nullif(v_settings->>'manager_id','')::integer;
 v_project=nullif(v_settings->>'project_id','')::integer;
 if v_manager is not null and not exists(select 1 from public.users where id=v_manager and is_active and is_sales_rep) then raise exception 'Manager unavailable';end if;
 if v_project is not null and not exists(select 1 from public.projects where id=v_project) then raise exception 'Project unavailable';end if;
 select count(*) into v_count from public.leads where archived_at is null and (crm_intake_phone(phone)=v_phone or crm_intake_phone(secondary_phone)=v_phone);
 if v_count>1 then v_outcome='AMBIGUOUS';
 else
   select * into v_lead from public.leads where crm_intake_phone(phone)=v_phone or crm_intake_phone(secondary_phone)=v_phone order by (archived_at is null) desc,id limit 1 for update;
   if found and v_lead.archived_at is not null then v_outcome='ARCHIVED';
   else
     v_note='[Источник: '||(v_settings->>'source')||'] '||(v_settings->>'campaign')||E'\nПолучено в CRM: '||v_now;
     if coalesce(p_lead->>'submitted_at','')<>'' then v_note=v_note||E'\nДата в источнике: '||left(p_lead->>'submitted_at',100);end if;
     v_note=v_note||E'\nИмя в заявке: '||left(p_lead->>'full_name',200);
     if coalesce(p_lead->>'notes','')<>'' then v_note=v_note||E'\n'||left(p_lead->>'notes',4000);end if;
     if v_lead.id is null then
       insert into public.leads(full_name,phone,source,status,notes,responsible_user_id,interested_project_id,assigned_at,created_at,updated_at)
       values(left(p_lead->>'full_name',200),'+'||v_phone,v_settings->>'source','NEW',v_note,v_manager,v_project,case when v_manager is not null then now() end,v_now,v_now) returning * into v_lead;
       v_outcome='CREATED';
       if v_manager is not null then
         insert into public.lead_assignment_history(lead_id,to_user_id,assigned_by_user_id,assignment_type,reason)
         values(v_lead.id,v_manager,v_actor,'MANUAL','Импорт / Google Форма');
       end if;
     else
       v_outcome='REPEAT';
       insert into public.lead_notes(lead_id,author_user_id,body,created_at) values(v_lead.id,v_actor,v_note,v_now);
     end if;
     -- Existing owner, pipeline stage and core contact data are never overwritten.
     if v_lead.responsible_user_id is not null and exists(select 1 from public.users where id=v_lead.responsible_user_id and is_active and is_sales_rep) then
       v_task_title=case when v_outcome='CREATED' then 'Первичный контакт: ' else 'Повторное обращение: ' end||v_lead.full_name;
       insert into public.tasks(lead_id,assigned_user_id,created_by,type,title,description,client_name,phone,due_date,priority,status)
       values(v_lead.id,v_lead.responsible_user_id,v_actor,'CALL',v_task_title,'Связаться с клиентом. Источник: '||(v_settings->>'campaign'),v_lead.full_name,v_lead.phone,(now() at time zone 'Asia/Dushanbe')::date::text,'HIGH','OPEN')
       on conflict do nothing returning id into v_task_id;
     end if;
   end if;
 end if;
 insert into public.crm_lead_inquiries(scope,external_key,integration_id,lead_id,source,campaign,submitted_at,outcome,created_by)
 values(p_scope,p_key,p_integration,v_lead.id,v_settings->>'source',v_settings->>'campaign',left(p_lead->>'submitted_at',100),v_outcome,v_actor);
 if p_integration is not null then update public.crm_lead_integrations set last_received_at=now() where id=p_integration;end if;
 return jsonb_build_object('outcome',v_outcome,'lead_id',v_lead.id,'task_id',v_task_id);
end;
$$;
revoke all on function public.crm_intake_lead(text,text,jsonb,jsonb,integer,uuid) from public,anon,authenticated;
grant execute on function public.crm_intake_lead(text,text,jsonb,jsonb,integer,uuid) to service_role;
