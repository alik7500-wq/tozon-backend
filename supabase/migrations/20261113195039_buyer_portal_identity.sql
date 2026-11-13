-- Additive, opt-in buyer authentication. No existing finance/payment rows are changed.
create table public.buyer_portal_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  deal_id integer not null references public.deals(id),
  lead_id integer not null references public.leads(id),
  phone_snapshot text not null,
  created_by integer not null references public.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index buyer_portal_invites_deal on public.buyer_portal_invites(deal_id);

create table public.buyer_portal_bindings (
  id uuid primary key default gen_random_uuid(),
  lead_id integer not null references public.leads(id),
  telegram_id bigint not null check (telegram_id > 0),
  phone_snapshot text not null,
  language text not null default 'tj' check (language in ('tj','ru')),
  verified_at timestamptz not null default now(),
  last_active_at timestamptz,
  revoked_at timestamptz
);
create unique index buyer_portal_binding_lead on public.buyer_portal_bindings(lead_id) where revoked_at is null;
create unique index buyer_portal_binding_telegram on public.buyer_portal_bindings(telegram_id) where revoked_at is null;

-- A binding is identity; an explicit grant is permission. Phone equality grants nothing.
create table public.buyer_portal_grants (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.buyer_portal_bindings(id),
  deal_id integer not null references public.deals(id),
  owner_lead_id integer not null references public.leads(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index buyer_portal_grant_unique on public.buyer_portal_grants(binding_id,deal_id) where revoked_at is null;
create index buyer_portal_grants_deal on public.buyer_portal_grants(deal_id);

create table public.buyer_portal_otp (
  id uuid primary key,
  invite_id uuid not null references public.buyer_portal_invites(id),
  lead_id integer not null references public.leads(id),
  telegram_id bigint not null check (telegram_id > 0),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  delivered_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz
);
create index buyer_portal_otp_lead_time on public.buyer_portal_otp(lead_id,created_at);
create index buyer_portal_otp_telegram_time on public.buyer_portal_otp(telegram_id,created_at);
create index buyer_portal_otp_invite on public.buyer_portal_otp(invite_id);

create table public.buyer_portal_audit (
  id bigint generated always as identity primary key,
  event text not null,
  invite_id uuid references public.buyer_portal_invites(id),
  lead_id integer references public.leads(id),
  telegram_id bigint,
  actor_user_id integer references public.users(id),
  created_at timestamptz not null default now()
);

-- Invoker functions: callable only by backend service_role, never public/auth clients.
create function public.buyer_portal_prepare_otp(p_token_hash text,p_telegram_id bigint,p_id uuid,p_code_hash text)
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
  if d.status <> 'SIGNED' or d.lead_id is distinct from i.lead_id or l.phone is distinct from i.phone_snapshot then
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

create function public.buyer_portal_confirm_otp(p_id uuid,p_telegram_id bigint,p_code_hash text)
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
  if d.status <> 'SIGNED' or d.lead_id is distinct from i.lead_id or l.phone is distinct from i.phone_snapshot then
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
  insert into public.buyer_portal_grants(binding_id,deal_id,owner_lead_id) values(b.id,i.deal_id,i.lead_id)
    on conflict(binding_id,deal_id) where revoked_at is null do nothing;
  update public.buyer_portal_otp set consumed_at=now() where id=c.id;
  update public.buyer_portal_invites set consumed_at=now() where id=i.id;
  insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('CONTRACT_LINKED',i.id,i.lead_id,p_telegram_id);
  return jsonb_build_object('status','VERIFIED');
end $$;

-- Always recheck live ownership/phone/status: a Telegram identity alone is insufficient.
create function public.buyer_portal_access(p_telegram_id bigint)
returns table(deal_id integer,binding_id uuid,language text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select g.deal_id,b.id,b.language from public.buyer_portal_bindings b
  join public.buyer_portal_grants g on g.binding_id=b.id and g.revoked_at is null
  join public.deals d on d.id=g.deal_id and d.lead_id=g.owner_lead_id and d.status='SIGNED'
  join public.leads l on l.id=b.lead_id and l.phone=b.phone_snapshot
  where b.telegram_id=p_telegram_id and b.revoked_at is null and b.lead_id=g.owner_lead_id
$$;

create function public.buyer_portal_revoke_changed_deal() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.lead_id is distinct from old.lead_id or new.status is distinct from old.status then
    update public.buyer_portal_grants set revoked_at=now() where deal_id=new.id and revoked_at is null;
    update public.buyer_portal_invites set revoked_at=now() where deal_id=new.id and revoked_at is null;
    insert into public.buyer_portal_audit(event) values('DEAL_ACCESS_REVOKED');
  end if;
  return new;
end $$;
create trigger buyer_portal_deal_changed after update of lead_id,status on public.deals
for each row execute function public.buyer_portal_revoke_changed_deal();

create function public.buyer_portal_revoke_changed_phone() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.phone is distinct from old.phone then
    update public.buyer_portal_bindings set revoked_at=now() where lead_id=new.id and revoked_at is null;
    update public.buyer_portal_invites set revoked_at=now() where lead_id=new.id and revoked_at is null;
    insert into public.buyer_portal_audit(event,lead_id) values('PHONE_ACCESS_REVOKED',new.id);
  end if;
  return new;
end $$;
create trigger buyer_portal_phone_changed after update of phone on public.leads
for each row execute function public.buyer_portal_revoke_changed_phone();

create function public.buyer_portal_unlink(p_lead_id integer,p_actor_user_id integer)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(71201,p_lead_id);
  update public.buyer_portal_bindings set revoked_at=now() where lead_id=p_lead_id and revoked_at is null;
  update public.buyer_portal_grants set revoked_at=now() where binding_id in
    (select id from public.buyer_portal_bindings where lead_id=p_lead_id) and revoked_at is null;
  update public.buyer_portal_invites set revoked_at=now() where lead_id=p_lead_id and revoked_at is null;
  insert into public.buyer_portal_audit(event,lead_id,actor_user_id) values('STAFF_UNLINKED',p_lead_id,p_actor_user_id);
end $$;

alter table public.buyer_portal_invites enable row level security;
alter table public.buyer_portal_bindings enable row level security;
alter table public.buyer_portal_grants enable row level security;
alter table public.buyer_portal_otp enable row level security;
alter table public.buyer_portal_audit enable row level security;
revoke all on public.buyer_portal_invites,public.buyer_portal_bindings,public.buyer_portal_grants,public.buyer_portal_otp,public.buyer_portal_audit from public,anon,authenticated;
grant select,insert,update,delete on public.buyer_portal_invites,public.buyer_portal_bindings,public.buyer_portal_grants,public.buyer_portal_otp,public.buyer_portal_audit to service_role;
revoke all on sequence public.buyer_portal_audit_id_seq from public,anon,authenticated;
grant usage,select on sequence public.buyer_portal_audit_id_seq to service_role;
revoke all on function public.buyer_portal_prepare_otp(text,bigint,uuid,text),public.buyer_portal_confirm_otp(uuid,bigint,text),public.buyer_portal_access(bigint),public.buyer_portal_revoke_changed_deal(),public.buyer_portal_revoke_changed_phone() from public,anon,authenticated;
grant execute on function public.buyer_portal_prepare_otp(text,bigint,uuid,text),public.buyer_portal_confirm_otp(uuid,bigint,text),public.buyer_portal_access(bigint),public.buyer_portal_revoke_changed_deal(),public.buyer_portal_revoke_changed_phone() to service_role;
revoke all on function public.buyer_portal_unlink(integer,integer) from public,anon,authenticated;
grant execute on function public.buyer_portal_unlink(integer,integer) to service_role;
