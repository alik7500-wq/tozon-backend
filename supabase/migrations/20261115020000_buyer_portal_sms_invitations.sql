-- Long invitations initiate staff-approved onboarding; they never grant access alone.
alter table public.buyer_portal_invites
 add column source text not null default 'QR' check(source in ('QR','SMS_INVITE')),
 add column sms_request_id uuid unique,
 add column sms_language text check(sms_language in ('tj','ru')),
 add column sms_delivery_status text check(sms_delivery_status in ('SENDING','SENT','FAILED','UNKNOWN')),
 add column sms_sent_at timestamptz;
alter table public.buyer_portal_invites drop constraint buyer_portal_invites_check;
alter table public.buyer_portal_invites add constraint buyer_portal_invites_check check (
 expires_at>created_at and expires_at<=created_at+case when source='SMS_INVITE' then interval '7 days' else interval '15 minutes' end
);
create index buyer_invites_sms_lead_time on public.buyer_portal_invites(lead_id,created_at desc) where source='SMS_INVITE';

create function public.buyer_portal_onboarding_list(p_actor integer) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(item order by item->>'name'),'[]'::jsonb) from (
 select jsonb_build_object('leadId',l.id,'name',l.full_name,'phone',l.phone,
 'dealId',min(d.id),'contracts',count(distinct d.id),
 'status',case when exists(select 1 from public.buyer_portal_bindings b join public.buyer_portal_access(b.telegram_id) a on a.binding_id=b.id where b.lead_id=l.id and b.revoked_at is null) then 'CONNECTED'
 when exists(select 1 from public.buyer_portal_invites i where i.lead_id=l.id and i.revoked_at is null and i.consumed_at is null and i.expires_at>now() and i.claimed_telegram_id is not null) then 'PENDING'
 when recent.sms_delivery_status='SENT' then 'INVITED'
 when recent.sms_delivery_status in ('SENDING','UNKNOWN') then 'UNKNOWN'
 when recent.sms_delivery_status='FAILED' then 'FAILED' else 'NOT_INVITED' end,
 'lastSentAt',recent.sms_sent_at,'lastAttemptAt',recent.created_at,'expiresAt',recent.expires_at,'language',recent.sms_language,
 'pendingDealId',(select i.deal_id from public.buyer_portal_invites i where i.lead_id=l.id and i.revoked_at is null and i.consumed_at is null and i.expires_at>now() and i.claimed_telegram_id is not null order by i.created_at desc limit 1),
 'canSend',not exists(select 1 from public.buyer_portal_invites i where i.lead_id=l.id and i.source='SMS_INVITE' and i.created_at>now()-interval '24 hours')
 ) item
 from public.users actor join public.deals d on d.status='SIGNED' and (actor.role in ('ADMIN','DIRECTOR') or (actor.role='SALES_MANAGER' and d.responsible_user_id=actor.id))
 join public.leads l on l.id=d.lead_id
 left join lateral(select i.* from public.buyer_portal_invites i where i.lead_id=l.id and i.source='SMS_INVITE' order by i.created_at desc limit 1) recent on true
 where actor.id=p_actor and actor.is_active=1
 group by l.id,l.full_name,l.phone,recent.sms_delivery_status,recent.sms_sent_at,recent.created_at,recent.expires_at,recent.sms_language
 ) clients
$$;

create function public.buyer_portal_prepare_sms_invite(p_lead integer,p_actor integer,p_hash text,p_request uuid,p_language text,p_phone text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare d public.deals;l public.leads;i public.buyer_portal_invites;
begin
 if p_language not in ('tj','ru') or p_language is null or p_request is null then return jsonb_build_object('status','UNAVAILABLE');end if;
 perform pg_advisory_xact_lock(71201,p_lead);
 select * into l from public.leads where id=p_lead for share;
 if not found or l.phone is distinct from p_phone then return jsonb_build_object('status','PHONE_CHANGED');end if;
 select x.* into d from public.deals x join public.users u on u.id=p_actor and u.is_active=1
 where x.lead_id=p_lead and x.status='SIGNED' and (u.role in ('ADMIN','DIRECTOR') or (u.role='SALES_MANAGER' and x.responsible_user_id=u.id)) order by x.id limit 1 for share of x;
 if not found then return jsonb_build_object('status','UNAVAILABLE');end if;
 select * into i from public.buyer_portal_invites where sms_request_id=p_request;
 if found then
   if i.lead_id=p_lead and i.created_by=p_actor then return jsonb_build_object('status','EXISTING','deliveryStatus',i.sms_delivery_status);end if;
   return jsonb_build_object('status','UNAVAILABLE');
 end if;
 if exists(select 1 from public.buyer_portal_bindings b join public.buyer_portal_access(b.telegram_id) a on a.binding_id=b.id where b.lead_id=p_lead and b.revoked_at is null) then return jsonb_build_object('status','CONNECTED');end if;
 if exists(select 1 from public.buyer_portal_invites v where v.lead_id=p_lead and v.revoked_at is null and v.consumed_at is null and v.expires_at>now() and v.claimed_telegram_id is not null) then return jsonb_build_object('status','PENDING');end if;
 if exists(select 1 from public.buyer_portal_invites where lead_id=p_lead and source='SMS_INVITE' and created_at>now()-interval '24 hours') then return jsonb_build_object('status','RATE_LIMITED');end if;
 insert into public.buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,phone_snapshot,created_by,expires_at,source,sms_request_id,sms_language,sms_delivery_status)
 values(p_hash,d.id,p_lead,p_lead,l.phone,p_actor,now()+interval '7 days','SMS_INVITE',p_request,p_language,'SENDING') returning * into i;
 insert into public.buyer_portal_audit(event,invite_id,lead_id,actor_user_id) values('SMS_INVITATION_PREPARED',i.id,p_lead,p_actor);
 return jsonb_build_object('status','CREATED','id',i.id,'dealId',d.id,'expiresAt',i.expires_at);
end $$;
revoke all on function public.buyer_portal_onboarding_list(integer),public.buyer_portal_prepare_sms_invite(integer,integer,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.buyer_portal_onboarding_list(integer),public.buyer_portal_prepare_sms_invite(integer,integer,text,uuid,text,text) to service_role;
