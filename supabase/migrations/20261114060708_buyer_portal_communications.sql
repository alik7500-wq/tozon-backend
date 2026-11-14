alter table public.buyer_portal_bindings add column notifications_enabled boolean not null default true;
alter table public.buyer_portal_grants add column last_reminder_check timestamptz;
create table public.buyer_portal_notices (
 id uuid primary key default gen_random_uuid(),binding_id uuid not null references public.buyer_portal_bindings(id),
 deal_id integer not null references public.deals(id),kind text not null check(kind in ('PAYMENT','PAYMENT_VOIDED','DOCUMENT','SCHEDULE_CHANGED','TERMS_CHANGED','REMINDER_7','REMINDER_3','REMINDER_0','OVERDUE','INQUIRY_REPLY')),
 event_key text not null,source_id text,source_version text,due_date date,
 status text not null default 'PENDING' check(status in ('PENDING','SENDING','SENT','CANCELLED','FAILED','UNKNOWN')),
 worker_token uuid,claimed_at timestamptz,available_at timestamptz not null default now(),attempts integer not null default 0,
 created_at timestamptz not null default now(),finished_at timestamptz,error_code text,read_at timestamptz,
 unique(binding_id,event_key)
);
create index buyer_portal_notice_pending on public.buyer_portal_notices(available_at,created_at) where status='PENDING';
create index buyer_portal_notice_inbox on public.buyer_portal_notices(binding_id,finished_at desc) where status='SENT';
create table public.buyer_portal_inquiries (
 id uuid primary key,binding_id uuid not null references public.buyer_portal_bindings(id),deal_id integer not null references public.deals(id),
 lead_id integer not null references public.leads(id),message text not null check(length(message) between 1 and 2000),
 task_id integer references public.tasks(id),status text not null default 'OPEN' check(status in ('OPEN','ANSWERED')),
 reply text check(length(reply) between 1 and 2000),replied_by integer references public.users(id),
 created_at timestamptz not null default now(),replied_at timestamptz
);
create index buyer_portal_inquiries_deal on public.buyer_portal_inquiries(deal_id,created_at);
create index buyer_portal_inquiries_rate on public.buyer_portal_inquiries(binding_id,created_at);
alter table public.buyer_portal_notices enable row level security;
alter table public.buyer_portal_inquiries enable row level security;
revoke all on public.buyer_portal_notices,public.buyer_portal_inquiries from public,anon,authenticated;
grant select,insert,update on public.buyer_portal_notices,public.buyer_portal_inquiries to service_role;

create schema if not exists buyer_internal;
revoke all on schema buyer_internal from public,anon,authenticated;
grant usage on schema buyer_internal to service_role;
create function buyer_internal.payment_version(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select md5(jsonb_build_array(case when p->>'status' in ('ACTIVE','POSTED') then 'CONFIRMED' else p->>'status' end,p->'amount_minor',p->'currency',p->'amount_usd',p->'amount_tjs',p->'exchange_rate',p->'deal_id',p->'operation_type',p->'settlement_method',p->'transfer_id',p->'conversion_id')::text)
$$;
create function buyer_internal.schedule_version(p_deal integer) returns text language sql volatile set search_path=pg_catalog,public as $$
 select md5(coalesce(jsonb_agg(jsonb_build_array(id,due_date,amount_minor) order by due_date,id),'[]'::jsonb)::text) from public.deal_payment_schedules where deal_id=p_deal
$$;
create function buyer_internal.terms_version(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select md5(jsonb_build_array(p->'final_price_minor',p->'down_payment_minor',p->'first_payment_date',p->'payment_type',p->'unit_id')::text)
$$;

create function public.buyer_portal_queue_notice(p_deal integer,p_kind text,p_key text,p_source text default null,p_version text default null,p_due date default null)
returns void language sql security invoker set search_path=pg_catalog,public as $$
 insert into public.buyer_portal_notices(binding_id,deal_id,kind,event_key,source_id,source_version,due_date)
 select b.id,p_deal,p_kind,p_key,p_source,p_version,p_due from public.buyer_portal_bindings b
 join public.buyer_portal_grants g on g.binding_id=b.id and g.deal_id=p_deal and g.revoked_at is null
 join public.deals d on d.id=g.deal_id and d.status='SIGNED' and d.lead_id=g.owner_lead_id and d.lead_id=b.lead_id
 join public.leads l on l.id=b.lead_id and l.phone=b.phone_snapshot
 where b.revoked_at is null and b.notifications_enabled
 on conflict(binding_id,event_key) do nothing
$$;

-- Internal trigger only: derives events from committed CRM rows, never from a caller payload.
-- Definer is required because existing CRM posting functions use different DB roles.
create function buyer_internal.queue_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public,buyer_internal as $$
declare version text; v_kind text; target integer; source text;
begin
 if TG_TABLE_NAME='payments' then
  if NEW.deal_id is null or coalesce(NEW.operation_type,'STANDARD') not in ('STANDARD','INCOME','DEAL_PAYMENT')
    or NEW.transfer_id is not null or NEW.conversion_id is not null or coalesce(NEW.settlement_method,'CASH') in ('INTERNAL_TRANSFER','CONVERSION') then return NEW;end if;
  if NEW.status in ('ACTIVE','POSTED') and NEW.amount_minor>0 then v_kind:='PAYMENT';
  elsif TG_OP='UPDATE' and NEW.status='VOIDED' and OLD.status in ('ACTIVE','POSTED') then v_kind:='PAYMENT_VOIDED';
  else return NEW;end if;
  version:=buyer_internal.payment_version(to_jsonb(NEW));
  if TG_OP='UPDATE' and version=buyer_internal.payment_version(to_jsonb(OLD)) then return NEW;end if;
  target:=NEW.deal_id;source:=NEW.id::text;
 elsif TG_TABLE_NAME='buyer_portal_documents' then
  if NEW.status<>'PUBLISHED' or (TG_OP='UPDATE' and OLD.status='PUBLISHED') then return NEW;end if;
  target:=NEW.deal_id;source:=NEW.id::text;v_kind:='DOCUMENT';version:=NEW.sha256;
 elsif TG_TABLE_NAME='deal_payment_schedules' then
  if TG_OP='UPDATE' and NEW.due_date is not distinct from OLD.due_date and NEW.amount_minor is not distinct from OLD.amount_minor then return NEW;end if;
  target:=case when TG_OP='DELETE' then OLD.deal_id else NEW.deal_id end;v_kind:='SCHEDULE_CHANGED';version:=buyer_internal.schedule_version(target);
  -- One notice per transaction, current version replaces intermediate row-by-row versions.
  perform public.buyer_portal_queue_notice(target,v_kind,v_kind||':'||target||':'||txid_current(),null,version);
  update public.buyer_portal_notices set source_version=version where deal_id=target and event_key=v_kind||':'||target||':'||txid_current() and status='PENDING';
  if TG_OP='DELETE' then return OLD;end if;
  return NEW;
 else
  if buyer_internal.terms_version(to_jsonb(NEW))=buyer_internal.terms_version(to_jsonb(OLD)) then return NEW;end if;
  target:=NEW.id;v_kind:='TERMS_CHANGED';version:=buyer_internal.terms_version(to_jsonb(NEW));
 end if;
 perform public.buyer_portal_queue_notice(target,v_kind,v_kind||':'||coalesce(source,target::text)||':'||version,source,version);
 return NEW;
end $$;
create trigger buyer_portal_payment_notice after insert or update on public.payments for each row execute function buyer_internal.queue_change();
create trigger buyer_portal_document_notice after insert or update on public.buyer_portal_documents for each row execute function buyer_internal.queue_change();
create trigger buyer_portal_schedule_notice after insert or delete or update of due_date,amount_minor on public.deal_payment_schedules for each row execute function buyer_internal.queue_change();
create trigger buyer_portal_terms_notice after update of final_price_minor,down_payment_minor,first_payment_date,payment_type,unit_id on public.deals for each row execute function buyer_internal.queue_change();

create function public.buyer_portal_claim_notice(p_worker uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.buyer_portal_notices;
begin
 update public.buyer_portal_notices set status='UNKNOWN',finished_at=now(),error_code='WORKER_INTERRUPTED' where status='SENDING' and claimed_at<now()-interval '5 minutes';
 select * into item from public.buyer_portal_notices where status='PENDING' and available_at<=now()
   and (kind not in ('REMINDER_7','REMINDER_3','REMINDER_0','OVERDUE') or extract(hour from now() at time zone 'Asia/Dushanbe') between 9 and 19)
   order by created_at,id limit 1 for update skip locked;
 if not found then return null;end if;
 update public.buyer_portal_notices set status='SENDING',worker_token=p_worker,claimed_at=now(),attempts=attempts+1 where id=item.id;
 return jsonb_build_object('id',item.id,'attempts',item.attempts+1);
end $$;
create function public.buyer_portal_notice_context(p_id uuid,p_worker uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,buyer_internal as $$
declare n public.buyer_portal_notices; b public.buyer_portal_bindings; d public.deals; p public.payments; doc public.buyer_portal_documents;
begin
 select * into n from public.buyer_portal_notices where id=p_id and worker_token=p_worker and status='SENDING';
 if not found then return null;end if;
 select * into b from public.buyer_portal_bindings where id=n.binding_id and revoked_at is null and notifications_enabled;
 if not found or not exists(select 1 from public.buyer_portal_access(b.telegram_id) a where a.binding_id=b.id and a.deal_id=n.deal_id) then return null;end if;
 select * into d from public.deals where id=n.deal_id;
 if n.created_at<now()-interval '24 hours' then return null;end if;
 if n.kind in ('PAYMENT','PAYMENT_VOIDED') then
  select * into p from public.payments where id=n.source_id::integer and deal_id=n.deal_id;
  if not found or buyer_internal.payment_version(to_jsonb(p)) is distinct from n.source_version then return null;end if;
 elsif n.kind='DOCUMENT' then
  select * into doc from public.buyer_portal_documents where id=n.source_id::uuid and deal_id=n.deal_id and owner_lead_id=d.lead_id and status='PUBLISHED';
  if not found or doc.sha256 is distinct from n.source_version then return null;end if;
  if not doc.is_signed_original and doc.kind in ('CONTRACT','SCHEDULE') and exists(select 1 from public.buyer_portal_documents x where x.deal_id=d.id and x.owner_lead_id=d.lead_id and x.status='PUBLISHED' and x.is_signed_original and x.kind=doc.kind and x.language=doc.language) then return null;end if;
 elsif n.kind='TERMS_CHANGED' and buyer_internal.terms_version(to_jsonb(d)) is distinct from n.source_version then return null;
 elsif n.kind='SCHEDULE_CHANGED' and buyer_internal.schedule_version(d.id) is distinct from n.source_version then return null;
 elsif n.kind='INQUIRY_REPLY' and not exists(select 1 from public.buyer_portal_inquiries i where i.id=n.source_id::uuid and i.binding_id=b.id and i.status='ANSWERED') then return null;
 end if;
 return jsonb_build_object('id',n.id,'kind',n.kind,'dealId',n.deal_id,'telegramId',b.telegram_id::text,'language',b.language,
   'contractNumber',d.contract_number,'sourceId',n.source_id,'dueDate',n.due_date,'createdAt',n.created_at);
end $$;
create function public.buyer_portal_finish_notice(p_id uuid,p_worker uuid,p_status text,p_error text default null,p_delay integer default 60)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if p_status not in ('SENT','CANCELLED','FAILED','UNKNOWN','PENDING') then raise exception 'INVALID_NOTICE_STATE';end if;
 update public.buyer_portal_notices set status=case when p_status='PENDING' and attempts>=3 then 'FAILED' else p_status end,
   error_code=left(p_error,80),available_at=now()+make_interval(secs=>greatest(1,least(p_delay,3600))),
   finished_at=case when p_status='PENDING' and attempts<3 then null else now() end
 where id=p_id and worker_token=p_worker and status='SENDING';
end $$;
create function public.buyer_portal_reminder_candidates() returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item record; result jsonb:='[]';
begin
 for item in select g.id,g.deal_id,b.telegram_id from public.buyer_portal_grants g join public.buyer_portal_bindings b on b.id=g.binding_id
   where g.revoked_at is null and b.revoked_at is null and b.notifications_enabled
   order by g.last_reminder_check nulls first,g.id limit 20 for update of g skip locked loop
  update public.buyer_portal_grants set last_reminder_check=now() where id=item.id;
  if exists(select 1 from public.buyer_portal_access(item.telegram_id) a where a.deal_id=item.deal_id) then
   result:=result||jsonb_build_array(jsonb_build_object('telegramId',item.telegram_id::text,'dealId',item.deal_id));end if;
 end loop;
 return result;
end $$;

create function public.buyer_portal_contact(p_telegram bigint,p_deal integer,p_id uuid,p_message text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare binding uuid; d public.deals; existing public.buyer_portal_inquiries; task integer; assigned integer;
begin
 select binding_id into binding from public.buyer_portal_access(p_telegram) where deal_id=p_deal;
 if binding is null then return jsonb_build_object('status','UNAVAILABLE');end if;
 perform pg_advisory_xact_lock(71203,p_deal);
 select * into existing from public.buyer_portal_inquiries where id=p_id;
 if found then
  if existing.binding_id=binding and existing.deal_id=p_deal and existing.message=btrim(p_message) then return jsonb_build_object('status','ACCEPTED','id',existing.id);end if;
  return jsonb_build_object('status','UNAVAILABLE');end if;
 if p_message is null or length(btrim(p_message)) not between 1 and 2000 then return jsonb_build_object('status','INVALID');end if;
 if exists(select 1 from public.buyer_portal_inquiries where binding_id=binding and created_at>now()-interval '1 minute')
   or (select count(*) from public.buyer_portal_inquiries where binding_id=binding and created_at>now()-interval '1 hour')>=10 then return jsonb_build_object('status','RATE_LIMITED');end if;
 select * into d from public.deals where id=p_deal for share;
 if not exists(select 1 from public.buyer_portal_access(p_telegram) where deal_id=p_deal and binding_id=binding) then return jsonb_build_object('status','UNAVAILABLE');end if;
 select id into assigned from public.users where id=d.responsible_user_id and is_active=1;
 if assigned is null then select id into assigned from public.users where is_active=1 and role in ('DIRECTOR','ADMIN') order by case when role='DIRECTOR' then 0 else 1 end,id limit 1;end if;
 select id into task from public.tasks where deal_id=p_deal and lead_id=d.lead_id and type='BUYER_INQUIRY' and status='OPEN' limit 1 for update;
 if task is null then
  insert into public.tasks(lead_id,deal_id,assigned_user_id,type,title,description,due_date,priority,status,idempotency_key)
  values(d.lead_id,d.id,assigned,'BUYER_INQUIRY','Обращение покупателя · договор №'||d.contract_number,
    btrim(p_message),(now() at time zone 'Asia/Dushanbe')::date::text,'HIGH','OPEN','buyer-inquiry:'||p_id) returning id into task;
 else update public.tasks set description=right(coalesce(description,'')||E'\n\n'||btrim(p_message),10000),assigned_user_id=assigned,updated_at=now() where id=task;end if;
 insert into public.buyer_portal_inquiries(id,binding_id,deal_id,lead_id,message,task_id) values(p_id,binding,p_deal,d.lead_id,btrim(p_message),task);
 insert into public.buyer_portal_audit(event,lead_id,telegram_id) values('INQUIRY_CREATED',d.lead_id,p_telegram);
 return jsonb_build_object('status','ACCEPTED','id',p_id);
end $$;
create function public.buyer_portal_inquiry_history(p_telegram bigint,p_deal integer) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'message',i.message,'status',i.status,'reply',i.reply,'createdAt',i.created_at,'repliedAt',i.replied_at) order by i.created_at desc),'[]'::jsonb)
 from public.buyer_portal_inquiries i join public.buyer_portal_access(p_telegram) a on a.deal_id=i.deal_id and a.binding_id=i.binding_id where i.deal_id=p_deal
$$;
create function public.buyer_portal_reply(p_deal integer,p_id uuid,p_actor integer,p_reply text) returns text
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.buyer_portal_inquiries; d public.deals;
begin
 if p_reply is null or length(btrim(p_reply)) not between 1 and 2000 then raise exception 'INVALID_REPLY';end if;
 select * into d from public.deals where id=p_deal and status='SIGNED' for share;
 if not found then raise exception 'INQUIRY_UNAVAILABLE';end if;
 select * into item from public.buyer_portal_inquiries where id=p_id and deal_id=p_deal and lead_id=d.lead_id for update;
 if not found then raise exception 'INQUIRY_UNAVAILABLE';end if;
 if item.status='ANSWERED' then
  if item.reply=btrim(p_reply) then return item.status;end if;
  raise exception 'INQUIRY_ALREADY_ANSWERED';end if;
 update public.buyer_portal_inquiries set status='ANSWERED',reply=btrim(p_reply),replied_by=p_actor,replied_at=now() where id=p_id;
 if not exists(select 1 from public.buyer_portal_inquiries where task_id=item.task_id and status='OPEN') then update public.tasks set status='COMPLETED',completed_at=now(),updated_at=now() where id=item.task_id and status='OPEN';end if;
 perform public.buyer_portal_queue_notice(d.id,'INQUIRY_REPLY','INQUIRY_REPLY:'||p_id,p_id::text,null);
 insert into public.buyer_portal_audit(event,lead_id,actor_user_id) values('INQUIRY_REPLIED',d.lead_id,p_actor);
 return 'ANSWERED';
end $$;

create function buyer_internal.reassign_inquiry_tasks() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if NEW.lead_id is distinct from OLD.lead_id or NEW.status<>'SIGNED' then
  update public.tasks set status='CANCELLED',updated_at=now() where deal_id=NEW.id and type='BUYER_INQUIRY' and status='OPEN';
 elsif NEW.responsible_user_id is distinct from OLD.responsible_user_id then
  update public.tasks set assigned_user_id=NEW.responsible_user_id,updated_at=now() where deal_id=NEW.id and lead_id=NEW.lead_id and type='BUYER_INQUIRY' and status='OPEN';
 end if;
 return NEW;
end $$;
create trigger buyer_portal_inquiry_assignment after update of lead_id,status,responsible_user_id on public.deals for each row execute function buyer_internal.reassign_inquiry_tasks();

create function public.buyer_portal_notification_settings(p_telegram bigint,p_enabled boolean,p_language text default null) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b public.buyer_portal_bindings;
begin
 if p_enabled is null or (p_language is not null and p_language not in ('tj','ru')) then raise exception 'INVALID_SETTINGS';end if;
 select x.* into b from public.buyer_portal_bindings x where x.telegram_id=p_telegram and x.revoked_at is null
   and exists(select 1 from public.buyer_portal_access(p_telegram) a where a.binding_id=x.id) for update;
 if not found then return null;end if;
 update public.buyer_portal_bindings set notifications_enabled=p_enabled,language=coalesce(p_language,language) where id=b.id;
 if not p_enabled then update public.buyer_portal_notices set status='CANCELLED',finished_at=now(),error_code='USER_DISABLED' where binding_id=b.id and status='PENDING';end if;
 insert into public.buyer_portal_audit(event,lead_id,telegram_id) values('NOTIFICATION_SETTINGS_CHANGED',b.lead_id,p_telegram);
 return jsonb_build_object('enabled',p_enabled,'language',coalesce(p_language,b.language));
end $$;
create function public.buyer_portal_notice_history(p_telegram bigint) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(item),'[]'::jsonb) from (
  select jsonb_build_object('id',n.id,'kind',n.kind,'date',n.finished_at,'readAt',n.read_at,'contractNumber',d.contract_number) item
  from public.buyer_portal_notices n join public.buyer_portal_access(p_telegram) a on a.binding_id=n.binding_id and a.deal_id=n.deal_id
  join public.deals d on d.id=n.deal_id where n.status='SENT' order by n.finished_at desc limit 50
 ) recent
$$;
create function public.buyer_portal_read_notice(p_telegram bigint,p_id uuid) returns void language sql security invoker set search_path=pg_catalog,public as $$
 update public.buyer_portal_notices n set read_at=coalesce(n.read_at,now()) where n.id=p_id and n.status='SENT'
 and exists(select 1 from public.buyer_portal_access(p_telegram) a where a.binding_id=n.binding_id and a.deal_id=n.deal_id)
$$;

revoke all on all functions in schema buyer_internal from public,anon,authenticated;
grant execute on all functions in schema buyer_internal to service_role;
revoke all on function public.buyer_portal_queue_notice(integer,text,text,text,text,date),public.buyer_portal_claim_notice(uuid),public.buyer_portal_notice_context(uuid,uuid),public.buyer_portal_finish_notice(uuid,uuid,text,text,integer),public.buyer_portal_reminder_candidates(),public.buyer_portal_contact(bigint,integer,uuid,text),public.buyer_portal_inquiry_history(bigint,integer),public.buyer_portal_reply(integer,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.buyer_portal_queue_notice(integer,text,text,text,text,date),public.buyer_portal_claim_notice(uuid),public.buyer_portal_notice_context(uuid,uuid),public.buyer_portal_finish_notice(uuid,uuid,text,text,integer),public.buyer_portal_reminder_candidates(),public.buyer_portal_contact(bigint,integer,uuid,text),public.buyer_portal_inquiry_history(bigint,integer),public.buyer_portal_reply(integer,uuid,integer,text) to service_role;
revoke all on function public.buyer_portal_notification_settings(bigint,boolean,text),public.buyer_portal_notice_history(bigint),public.buyer_portal_read_notice(bigint,uuid) from public,anon,authenticated;
grant execute on function public.buyer_portal_notification_settings(bigint,boolean,text),public.buyer_portal_notice_history(bigint),public.buyer_portal_read_notice(bigint,uuid) to service_role;
