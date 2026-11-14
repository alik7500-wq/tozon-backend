-- Additive permissions; no deal, payment or accounting amounts are changed.
create table public.buyer_portal_participants (
 id uuid primary key default gen_random_uuid(),deal_id integer not null references public.deals(id),
 lead_id integer not null references public.leads(id),owner_lead_id integer not null references public.leads(id),
 role text not null check(role in ('CO_BUYER','REPRESENTATIVE')),basis text not null check(length(basis) between 5 and 500),
 approved_by integer not null references public.users(id),created_at timestamptz not null default now(),revoked_at timestamptz,
 check(lead_id<>owner_lead_id)
);
create unique index buyer_participant_active on public.buyer_portal_participants(deal_id,lead_id) where revoked_at is null;
create index buyer_participant_lead on public.buyer_portal_participants(lead_id);
alter table public.buyer_portal_participants enable row level security;
revoke all on public.buyer_portal_participants from public,anon,authenticated;
grant select,insert,update on public.buyer_portal_participants to service_role;
alter table public.buyer_portal_invites add column owner_lead_id integer references public.leads(id),add column participant_id uuid references public.buyer_portal_participants(id);
update public.buyer_portal_invites set owner_lead_id=lead_id;
alter table public.buyer_portal_invites alter column owner_lead_id set not null;
alter table public.buyer_portal_grants add column participant_id uuid references public.buyer_portal_participants(id);
alter table public.buyer_portal_audit add column participant_id uuid references public.buyer_portal_participants(id);

-- A caller proves a relationship, never discovers one merely by phone equality.
create function buyer_internal.invite_relationship(p public.buyer_portal_invites) returns boolean
language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.deals d join public.leads l on l.id=p.lead_id and l.phone=p.phone_snapshot
 where d.id=p.deal_id and d.status='SIGNED' and d.lead_id=p.owner_lead_id
 and ((p.participant_id is null and p.lead_id=d.lead_id) or exists(
 select 1 from public.buyer_portal_participants x where x.id=p.participant_id and x.deal_id=d.id and x.owner_lead_id=d.lead_id and x.lead_id=p.lead_id and x.revoked_at is null)))
$$;
create or replace function public.buyer_portal_access(p_telegram_id bigint)
returns table(deal_id integer,binding_id uuid,language text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select g.deal_id,b.id,b.language from public.buyer_portal_bindings b
 join public.buyer_portal_grants g on g.binding_id=b.id and g.revoked_at is null
 join public.deals d on d.id=g.deal_id and d.lead_id=g.owner_lead_id and d.status='SIGNED'
 join public.leads l on l.id=b.lead_id and l.phone=b.phone_snapshot
 where b.telegram_id=p_telegram_id and b.revoked_at is null and (
 (g.participant_id is null and b.lead_id=g.owner_lead_id) or exists(
 select 1 from public.buyer_portal_participants x where x.id=g.participant_id and x.deal_id=d.id and x.owner_lead_id=d.lead_id and x.lead_id=b.lead_id and x.revoked_at is null))
$$;
create function public.buyer_portal_participant_add(p_deal integer,p_lead integer,p_role text,p_basis text,p_actor integer) returns uuid
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare d public.deals; result uuid;
begin
 if not exists(select 1 from public.users where id=p_actor and is_active=1 and role in ('ADMIN','DIRECTOR')) then raise exception 'BUYER_ACCESS_DENIED';end if;
 select * into d from public.deals where id=p_deal and status='SIGNED' for update;
 if not found or p_lead=d.lead_id or not exists(select 1 from public.leads where id=p_lead) then raise exception 'BUYER_PARTICIPANT_INVALID';end if;
 insert into public.buyer_portal_participants(deal_id,lead_id,owner_lead_id,role,basis,approved_by)
 values(d.id,p_lead,d.lead_id,p_role,btrim(p_basis),p_actor) returning id into result;
 insert into public.buyer_portal_audit(event,lead_id,actor_user_id,participant_id) values('PARTICIPANT_APPROVED',p_lead,p_actor,result);
 return result;
end $$;
create function public.buyer_portal_participant_revoke(p_deal integer,p_id uuid,p_actor integer) returns void
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.users where id=p_actor and is_active=1 and role in ('ADMIN','DIRECTOR')) then raise exception 'BUYER_ACCESS_DENIED';end if;
 update public.buyer_portal_participants set revoked_at=now() where id=p_id and deal_id=p_deal and revoked_at is null;
 update public.buyer_portal_invites set revoked_at=now() where participant_id=p_id and deal_id=p_deal and revoked_at is null;
 update public.buyer_portal_grants set revoked_at=now() where participant_id=p_id and deal_id=p_deal and revoked_at is null;
 insert into public.buyer_portal_audit(event,actor_user_id,participant_id) select 'PARTICIPANT_REVOKED',p_actor,id from public.buyer_portal_participants where id=p_id and deal_id=p_deal;
end $$;

create table public.buyer_portal_archives (
 id uuid primary key default gen_random_uuid(),binding_id uuid not null references public.buyer_portal_bindings(id),
 deal_id integer not null references public.deals(id),owner_lead_id integer not null references public.leads(id),
 participant_id uuid references public.buyer_portal_participants(id),snapshot jsonb not null,documents jsonb not null,
 created_at timestamptz not null default now(),revoked_at timestamptz,unique(binding_id,deal_id)
);
create index buyer_archive_deal on public.buyer_portal_archives(deal_id);
alter table public.buyer_portal_archives enable row level security;
revoke all on public.buyer_portal_archives from public,anon,authenticated;
grant select,insert,update on public.buyer_portal_archives to service_role;
create function public.buyer_portal_archive_access(p_telegram_id bigint)
returns table(deal_id integer,binding_id uuid,language text)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select a.deal_id,b.id,b.language from public.buyer_portal_archives a join public.buyer_portal_bindings b on b.id=a.binding_id
 join public.deals d on d.id=a.deal_id and d.status='CANCELLED' and d.lead_id=a.owner_lead_id
 join public.leads l on l.id=b.lead_id and l.phone=b.phone_snapshot
 where b.telegram_id=p_telegram_id and b.revoked_at is null and a.revoked_at is null and (
 (a.participant_id is null and b.lead_id=a.owner_lead_id) or exists(select 1 from public.buyer_portal_participants x
 where x.id=a.participant_id and x.lead_id=b.lead_id and x.deal_id=a.deal_id and x.owner_lead_id=a.owner_lead_id and x.revoked_at is null))
$$;
create function public.buyer_portal_archive_snapshot(p_telegram_id bigint,p_deal_id integer) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select a.snapshot||jsonb_build_object('archivedAt',a.created_at) from public.buyer_portal_archives a
 join public.buyer_portal_archive_access(p_telegram_id) v on v.binding_id=a.binding_id and v.deal_id=a.deal_id where a.deal_id=p_deal_id
$$;
create function buyer_internal.archive_terminated() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare item record; data jsonb; docs jsonb; refund jsonb;
begin
 if NEW.lead_id is distinct from OLD.lead_id or (OLD.status='CANCELLED' and NEW.status<>'CANCELLED') then
  update public.buyer_portal_archives set revoked_at=now() where deal_id=OLD.id and revoked_at is null;
 end if;
 -- Only actual signed termination, not cancelled reservations or unverified historical backfill.
 if OLD.status='SIGNED' and NEW.status='CANCELLED' and OLD.lead_id=NEW.lead_id and to_jsonb(NEW)->>'terminated_by_user_id' is not null then
  select jsonb_build_object('id',e.id,'amount_minor',e.amount_minor,'currency',e.currency,'expense_date',e.expense_date,
    'status',e.status,'reference',e.reference,'amount_usd',e.amount_usd,'amount_tjs',e.amount_tjs,'exchange_rate',e.exchange_rate)
  into refund from public.expenses e where e.id=NEW.refund_expense_id;
  for item in select b.telegram_id,g.binding_id,g.participant_id from public.buyer_portal_grants g join public.buyer_portal_bindings b on b.id=g.binding_id
    where g.deal_id=OLD.id and g.revoked_at is null and exists(select 1 from public.buyer_portal_access(b.telegram_id) a where a.deal_id=OLD.id and a.binding_id=b.id) loop
   data:=public.buyer_portal_contract_snapshot(item.telegram_id,OLD.id);
   docs:=public.buyer_portal_materials(item.telegram_id,OLD.id)->'documents';
   if data is not null then
    data:=jsonb_set(data,'{deal,status}','"CANCELLED"'::jsonb)||jsonb_build_object('refund',refund);
    insert into public.buyer_portal_archives(binding_id,deal_id,owner_lead_id,participant_id,snapshot,documents)
      values(item.binding_id,OLD.id,OLD.lead_id,item.participant_id,data,coalesce(docs,'[]'::jsonb)) on conflict(binding_id,deal_id) do nothing;
    insert into public.buyer_portal_audit(event,lead_id,telegram_id) values('CONTRACT_ARCHIVED',OLD.lead_id,item.telegram_id);
   end if;
  end loop;
 end if;
 return NEW;
end $$;
create trigger buyer_portal_archive_termination before update of lead_id,status on public.deals for each row execute function buyer_internal.archive_terminated();
create function buyer_internal.revoke_participants_changed() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if NEW.lead_id is distinct from OLD.lead_id or (NEW.status is distinct from OLD.status and not(OLD.status='SIGNED' and NEW.status='CANCELLED')) then
  update public.buyer_portal_participants set revoked_at=now() where deal_id=OLD.id and revoked_at is null;
 end if;
 return NEW;
end $$;
create trigger buyer_portal_participants_changed after update of lead_id,status on public.deals for each row execute function buyer_internal.revoke_participants_changed();

-- Existing OTP limits, locks, conflict checks and single-use rules remain in force.
create or replace function public.buyer_portal_prepare_otp(p_token_hash text,p_telegram_id bigint,p_id uuid,p_code_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare i public.buyer_portal_invites; d public.deals; l public.leads;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then return jsonb_build_object('status','UNAVAILABLE'); end if;
  select * into i from public.buyer_portal_invites where token_hash=p_token_hash for update;
  if not found or i.revoked_at is not null or i.consumed_at is not null or i.expires_at <= now() then
    return jsonb_build_object('status','UNAVAILABLE');
  end if;
  select * into d from public.deals where id=i.deal_id for share;
  select * into l from public.leads where id=i.lead_id for share;
  if not buyer_internal.invite_relationship(i) then
    return jsonb_build_object('status','UNAVAILABLE');
  end if;
  -- Serialize all invitations for the same buyer and all requests from one Telegram.
  perform pg_advisory_xact_lock(71201, i.lead_id);
  perform pg_advisory_xact_lock(hashtextextended('buyer-tg:' || p_telegram_id::text,0));
  if exists(select 1 from public.buyer_portal_otp where (lead_id=i.lead_id or telegram_id=p_telegram_id) and created_at > now()-interval '60 seconds')
    or (select count(*) from public.buyer_portal_otp where lead_id=i.lead_id and created_at > now()-interval '1 hour') >= 5
    or (select count(*) from public.buyer_portal_otp where telegram_id=p_telegram_id and created_at > now()-interval '1 hour') >= 5 then
    insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('OTP_RATE_LIMITED',i.id,i.lead_id,p_telegram_id);
    return jsonb_build_object('status','RATE_LIMITED');
  end if;
  update public.buyer_portal_otp set invalidated_at=now() where lead_id=i.lead_id and consumed_at is null and invalidated_at is null;
  insert into public.buyer_portal_otp(id,invite_id,lead_id,telegram_id,code_hash,expires_at)
    values(p_id,i.id,i.lead_id,p_telegram_id,p_code_hash,least(i.expires_at,now()+interval '5 minutes'));
  insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('OTP_REQUESTED',i.id,i.lead_id,p_telegram_id);
  return jsonb_build_object('status','PREPARED','challengeId',p_id,'phone',l.phone);
end $$;
create or replace function public.buyer_portal_confirm_otp(p_id uuid,p_telegram_id bigint,p_code_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.buyer_portal_otp; i public.buyer_portal_invites; d public.deals; l public.leads; b public.buyer_portal_bindings;
begin
  -- Lock invite first, matching prepare; this serializes two simultaneous redemptions.
  select v.* into i from public.buyer_portal_invites v join public.buyer_portal_otp o on o.invite_id=v.id where o.id=p_id for update of v;
  if not found then return jsonb_build_object('status','UNAVAILABLE'); end if;
  select * into c from public.buyer_portal_otp where id=p_id for update;
  if c.telegram_id is distinct from p_telegram_id or c.delivered_at is null or c.invalidated_at is not null
     or c.consumed_at is not null or c.expires_at <= now() or c.attempts >= 5
     or i.revoked_at is not null or i.consumed_at is not null or i.expires_at <= now() then
    return jsonb_build_object('status','UNAVAILABLE');
  end if;
  select * into d from public.deals where id=i.deal_id for share;
  select * into l from public.leads where id=i.lead_id for share;
  if not buyer_internal.invite_relationship(i) then
    return jsonb_build_object('status','UNAVAILABLE');
  end if;
  update public.buyer_portal_otp set attempts=attempts+1 where id=c.id;
  if c.code_hash is distinct from p_code_hash then
    insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('OTP_REJECTED',i.id,i.lead_id,p_telegram_id);
    return jsonb_build_object('status','INVALID_CODE');
  end if;
  perform pg_advisory_xact_lock(71201,i.lead_id);
  perform pg_advisory_xact_lock(hashtextextended('buyer-tg:' || p_telegram_id::text,0));
  if exists(select 1 from public.buyer_portal_bindings where revoked_at is null and
    ((lead_id=i.lead_id and telegram_id<>p_telegram_id) or (telegram_id=p_telegram_id and lead_id<>i.lead_id))) then
    insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('BINDING_CONFLICT',i.id,i.lead_id,p_telegram_id);
    return jsonb_build_object('status','STAFF_REVIEW_REQUIRED');
  end if;
  select * into b from public.buyer_portal_bindings where lead_id=i.lead_id and telegram_id=p_telegram_id and revoked_at is null;
  if not found then
    insert into public.buyer_portal_bindings(lead_id,telegram_id,phone_snapshot) values(i.lead_id,p_telegram_id,l.phone) returning * into b;
  end if;
  insert into public.buyer_portal_grants(binding_id,deal_id,owner_lead_id,participant_id) values(b.id,i.deal_id,i.owner_lead_id,i.participant_id)
    on conflict(binding_id,deal_id) where revoked_at is null do nothing;
  update public.buyer_portal_otp set consumed_at=now() where id=c.id;
  update public.buyer_portal_invites set consumed_at=now() where id=i.id;
  insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('CONTRACT_LINKED',i.id,i.lead_id,p_telegram_id);
  return jsonb_build_object('status','VERIFIED');
end $$;
create or replace function public.buyer_portal_visit(p_token_hash text,p_telegram_id bigint)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare i public.buyer_portal_invites;
begin
  if p_telegram_id is null or p_telegram_id<=0 then return false; end if;
  select v.* into i from public.buyer_portal_invites v
    join public.deals d on d.id=v.deal_id
    join public.leads l on l.id=v.lead_id and l.phone=v.phone_snapshot
    where buyer_internal.invite_relationship(v) and v.token_hash=p_token_hash and v.expires_at>now() and v.consumed_at is null and v.revoked_at is null;
  if not found then return false; end if;
  insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('BUYER_OPENED',i.id,i.lead_id,p_telegram_id);
  return true;
end $$;

alter function public.buyer_portal_contracts(bigint) rename to buyer_portal_live_contracts;
create function public.buyer_portal_contracts(p_telegram_id bigint) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select public.buyer_portal_live_contracts(p_telegram_id)||coalesce((select jsonb_agg(jsonb_build_object(
 'id',a.deal_id,'contractNumber',a.snapshot->'deal'->>'contract_number','projectName',a.snapshot->'property'->>'projectName',
 'unitNumber',a.snapshot->'property'->>'unitNumber','kind',a.snapshot->'property'->>'kind','status','CANCELLED','archived',true) order by a.created_at desc)
 from public.buyer_portal_archives a join public.buyer_portal_archive_access(p_telegram_id) v on v.binding_id=a.binding_id and v.deal_id=a.deal_id),'[]'::jsonb)
$$;
alter function public.buyer_portal_materials(bigint,integer) rename to buyer_portal_live_materials;
create function public.buyer_portal_materials(p_telegram_id bigint,p_deal_id integer) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(public.buyer_portal_live_materials(p_telegram_id,p_deal_id),(
 select jsonb_build_object('plan2d',null,'plan3d',null,'tour',null,'documents',coalesce((
 select jsonb_agg(item) from jsonb_array_elements(a.documents) item
 join public.buyer_portal_documents d on d.id=(item->>'id')::uuid and d.status='PUBLISHED' and d.owner_lead_id=a.owner_lead_id and d.deal_id=a.deal_id and d.sha256=item->>'sha256'
 ),'[]'::jsonb)) from public.buyer_portal_archives a
 join public.buyer_portal_archive_access(p_telegram_id) v on v.binding_id=a.binding_id and v.deal_id=a.deal_id where a.deal_id=p_deal_id))
$$;
create or replace function public.buyer_portal_queue_notice(p_deal integer,p_kind text,p_key text,p_source text default null,p_version text default null,p_due date default null)
returns void language sql security invoker set search_path=pg_catalog,public as $$
 insert into public.buyer_portal_notices(binding_id,deal_id,kind,event_key,source_id,source_version,due_date)
 select b.id,p_deal,p_kind,p_key,p_source,p_version,p_due from public.buyer_portal_bindings b
 join public.buyer_portal_grants g on g.binding_id=b.id and g.deal_id=p_deal and g.revoked_at is null
 where b.revoked_at is null and b.notifications_enabled and exists(select 1 from public.buyer_portal_access(b.telegram_id) a where a.binding_id=b.id and a.deal_id=p_deal)
 on conflict(binding_id,event_key) do nothing
$$;
create function buyer_internal.archive_immutable() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' or (to_jsonb(NEW)-'revoked_at') is distinct from (to_jsonb(OLD)-'revoked_at') or (OLD.revoked_at is not null and NEW.revoked_at is distinct from OLD.revoked_at) then raise exception 'BUYER_ARCHIVE_IMMUTABLE';end if;
 return NEW;
end $$;
create trigger buyer_portal_archive_immutable before update or delete on public.buyer_portal_archives for each row execute function buyer_internal.archive_immutable();
revoke all on all functions in schema buyer_internal from public,anon,authenticated;
grant execute on all functions in schema buyer_internal to service_role;
revoke all on function public.buyer_portal_participant_add(integer,integer,text,text,integer),public.buyer_portal_participant_revoke(integer,uuid,integer),public.buyer_portal_archive_access(bigint),public.buyer_portal_archive_snapshot(bigint,integer),public.buyer_portal_contracts(bigint),public.buyer_portal_materials(bigint,integer) from public,anon,authenticated;
grant execute on function public.buyer_portal_participant_add(integer,integer,text,text,integer),public.buyer_portal_participant_revoke(integer,uuid,integer),public.buyer_portal_archive_access(bigint),public.buyer_portal_archive_snapshot(bigint,integer),public.buyer_portal_contracts(bigint),public.buyer_portal_materials(bigint,integer) to service_role;

create or replace function public.buyer_portal_publish_document(p_deal_id integer,p_id uuid,p_owner integer,p_actor integer,p_action text)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare owner_id integer; item public.buyer_portal_documents; result text;
begin
 select lead_id into owner_id from public.deals where id=p_deal_id and (status='SIGNED' or (status='CANCELLED' and p_action='REVOKE')) for share;
 if not found or owner_id is distinct from p_owner then raise exception 'BUYER_DOCUMENT_UNAVAILABLE';end if;
 select * into item from public.buyer_portal_documents where id=p_id and deal_id=p_deal_id and owner_lead_id=owner_id for update;
 if not found or item.status='REVOKED' or p_action is null or p_action not in ('PUBLISH','REVOKE') then raise exception 'BUYER_DOCUMENT_UNAVAILABLE';end if;
 if p_action='PUBLISH' then
   if item.status='PUBLISHED' then return item.status;end if;
   update public.buyer_portal_documents set status='PUBLISHED',published_by=p_actor,published_at=now() where id=p_id;
   result:='PUBLISHED';
 else update public.buyer_portal_documents set status='REVOKED' where id=p_id;result:='REVOKED';end if;
 insert into public.buyer_portal_audit(event,lead_id,actor_user_id,document_id) values('DOCUMENT_'||result,owner_id,p_actor,p_id);
 return result;
end $$;

-- Preserve the agreed square-metre rate in current and archived snapshots.
create or replace function public.buyer_portal_contract_snapshot(p_telegram_id bigint,p_deal_id integer)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'deal',jsonb_build_object('id',d.id,'contract_number',d.contract_number,'deal_date',d.deal_date,
   'status',d.status,'price_per_m2_minor',to_jsonb(d)->'deal_price_per_m2_minor','currency',d.currency,'final_price_minor',d.final_price_minor,
   'down_payment_minor',d.down_payment_minor,'barter_amount_minor',d.barter_amount_minor,
   'payment_type',d.payment_type,'first_payment_date',d.first_payment_date),
 'property',jsonb_build_object('projectName',p.name,'buildingName',b.name,'sectionName',s.name,
   'floorNumber',f.floor_number,'unitNumber',u.unit_number,'kind',u.unit_kind,
   'areaM2x100',u.area_m2_x100,'rooms',u.rooms),
 'manager',jsonb_build_object('name',m.name),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'amount_minor',x.amount_minor,
   'currency',x.currency,'amount_usd',x.amount_usd,'amount_tjs',x.amount_tjs,'exchange_rate',x.exchange_rate,
   'payment_date',x.payment_date,'status',x.status,'operation_type',x.operation_type,
   'settlement_method',x.settlement_method,'method',x.method,'reference',x.reference,
   'document_number',x.document_number,'customer_pko_number',x.customer_pko_number,
   'comment',substring(x.comment from '\[Назначение:[^\]]{1,255}\]'),
   'transfer_id',x.transfer_id,'conversion_id',x.conversion_id) order by x.payment_date,x.id)
   from public.payments x where x.deal_id=d.id),'[]'::jsonb),
 'schedules',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'payment_number',x.payment_number,
   'due_date',x.due_date,'amount_minor',x.amount_minor,'paid_amount_minor',x.paid_amount_minor,'status',x.status)
   order by x.due_date,x.id) from public.deal_payment_schedules x where x.deal_id=d.id),'[]'::jsonb),
 'refund',(select jsonb_build_object('id',e.id,'amount_minor',e.amount_minor,'currency',e.currency,
   'expense_date',e.expense_date,'status',e.status,'reference',e.reference,
   'amount_usd',e.amount_usd,'amount_tjs',e.amount_tjs,'exchange_rate',e.exchange_rate)
   from public.expenses e where e.id=d.refund_expense_id))
 from public.buyer_portal_access(p_telegram_id) a join public.deals d on d.id=a.deal_id and d.id=p_deal_id
 join public.units u on u.id=d.unit_id join public.floors f on f.id=u.floor_id
 join public.sections s on s.id=f.section_id join public.buildings b on b.id=s.building_id
 join public.projects p on p.id=b.project_id left join public.users m on m.id=d.responsible_user_id
$$;
