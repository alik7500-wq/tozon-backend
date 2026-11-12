-- Durable inbox is installation-local. Only the trusted backend can access it.
create table public.crm_instagram_rollout (
 account_id text primary key,
 activated_at timestamptz not null default now()
);
create table public.crm_instagram_threads (
 account_id text not null,
 contact_id text not null,
 name text,
 preview text,
 updated_at timestamptz not null default now(),
 graph_updated_at text,
 history_synced_at timestamptz,
 next_cursor text,
 last_inbound_at timestamptz,
 reply_blocked_until timestamptz,
 lead_id integer references public.leads(id) on delete set null,
 primary key(account_id,contact_id)
);
create index crm_instagram_threads_updated_idx on public.crm_instagram_threads(account_id,updated_at desc);
create index crm_instagram_threads_lead_idx on public.crm_instagram_threads(lead_id) where lead_id is not null;
create table public.crm_instagram_history (
 account_id text not null,
 contact_id text not null,
 message_id text not null,
 created_at timestamptz not null,
 body jsonb not null,
 primary key(account_id,contact_id,message_id),
 foreign key(account_id,contact_id) references public.crm_instagram_threads(account_id,contact_id)
);
create index crm_instagram_history_time_idx on public.crm_instagram_history(account_id,contact_id,created_at desc,message_id desc);
alter table public.crm_instagram_rollout enable row level security;
alter table public.crm_instagram_threads enable row level security;
alter table public.crm_instagram_history enable row level security;
revoke all on public.crm_instagram_rollout,public.crm_instagram_threads,public.crm_instagram_history from public,anon,authenticated,service_role;
grant select,insert on public.crm_instagram_rollout to service_role;
grant select,insert,update on public.crm_instagram_threads,public.crm_instagram_history to service_role;

-- Atomic per-thread writes serialize retries and create at most one lead. Historical
-- imports never create leads; only inbound events after activation do. No fake phone.
create function public.crm_instagram_store_thread(
 p_account text,p_contact text,p_name text,p_preview text,p_updated text,
 p_messages jsonb default null,p_cursor text default null,p_complete boolean default false,p_graph_updated text default null
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 v_thread public.crm_instagram_threads%rowtype;
 v_message jsonb;
 v_time timestamptz;
 v_inbound timestamptz;
 v_updated timestamptz;
 v_activated timestamptz;
 v_lead integer;
 v_now text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 if p_account is null or p_contact is null or p_account !~ '^[0-9]{5,40}$' or p_contact !~ '^[0-9]{1,40}$' or p_contact=p_account then raise exception 'Invalid Instagram identity';end if;
 if not exists(select 1 from public.tozon_instagram_connections where instagram_user_id=p_account and status='connected') then raise exception 'Instagram disconnected';end if;
 if p_messages is not null and (jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>200) then raise exception 'Invalid message batch';end if;
 insert into public.crm_instagram_rollout(account_id) values(p_account) on conflict do nothing;
 select activated_at into v_activated from public.crm_instagram_rollout where account_id=p_account;
 v_updated=coalesce(nullif(p_updated,'')::timestamptz,now());
 insert into public.crm_instagram_threads(account_id,contact_id,name,preview,updated_at)
 values(p_account,p_contact,left(p_name,200),left(p_preview,2000),v_updated) on conflict do nothing;
 select * into v_thread from public.crm_instagram_threads where account_id=p_account and contact_id=p_contact for update;
 for v_message in select value from jsonb_array_elements(coalesce(p_messages,'[]')) loop
   if coalesce(v_message->>'message_id','')='' or length(v_message->>'message_id')>2048 then raise exception 'Invalid message id';end if;
   v_time=(v_message->>'created_at')::timestamptz;
   if v_time is null or v_time>now()+interval '5 minutes' then continue;end if;
   insert into public.crm_instagram_history(account_id,contact_id,message_id,created_at,body)
   values(p_account,p_contact,v_message->>'message_id',v_time,v_message)
   on conflict(account_id,contact_id,message_id) do update set body=case
     when excluded.body->>'contentUnavailable'='true' and excluded.body->>'deleted' is distinct from 'true'
       and crm_instagram_history.body->>'contentUnavailable'='false' then crm_instagram_history.body
     else excluded.body end;
   if v_message->>'is_echo'='false' and coalesce(v_message->>'deleted','false')<>'true' then v_inbound=greatest(v_inbound,v_time);end if;
 end loop;
 if v_thread.lead_id is null and v_inbound>=v_activated and v_inbound<=now() then
   insert into public.leads(full_name,phone,source,status,notes,created_at,updated_at)
   values(coalesce(nullif(left(p_name,200),''),'Instagram ID: '||p_contact),'','INSTAGRAM','NEW',
     'Instagram Direct. Аккаунт: '||p_account||'. Контакт: '||p_contact||E'\n'||coalesce(left(p_preview,2000),''),v_now,v_now) returning id into v_lead;
 end if;
 update public.crm_instagram_threads set
   name=coalesce(nullif(left(p_name,200),''),name),
   preview=case when p_preview is not null and v_updated>=updated_at then left(p_preview,2000) else preview end,
   updated_at=case when p_updated is not null then greatest(updated_at,v_updated) else greatest(updated_at,v_inbound) end,
   graph_updated_at=coalesce(p_graph_updated,graph_updated_at),
   history_synced_at=case when p_complete then now() else history_synced_at end,
   next_cursor=case when p_complete then p_cursor else next_cursor end,
   reply_blocked_until=case when v_inbound>coalesce(last_inbound_at,'epoch') then null else reply_blocked_until end,
   last_inbound_at=greatest(last_inbound_at,v_inbound),lead_id=coalesce(lead_id,v_lead)
 where account_id=p_account and contact_id=p_contact;
 return jsonb_build_object('lead_id',coalesce(v_thread.lead_id,v_lead),'created',v_lead is not null);
end;
$$;
revoke all on function public.crm_instagram_store_thread(text,text,text,text,text,jsonb,text,boolean,text) from public,anon,authenticated;
grant execute on function public.crm_instagram_store_thread(text,text,text,text,text,jsonb,text,boolean,text) to service_role;
