-- Telegram identity is persisted; first access requires an explicit CRM staff approval.
alter table public.buyer_portal_invites add column claimed_telegram_id bigint, add column claim_code text, add column approved_by integer references public.users(id);
create function public.buyer_portal_request_connection(p_token_hash text,p_telegram bigint) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare i public.buyer_portal_invites;
begin
 if p_telegram is null or p_telegram<=0 then return jsonb_build_object('status','UNAVAILABLE');end if;
 select * into i from public.buyer_portal_invites where token_hash=p_token_hash for update;
 if not found or i.revoked_at is not null then return jsonb_build_object('status','UNAVAILABLE');end if;
 if exists(select 1 from public.buyer_portal_access(p_telegram) a where a.deal_id=i.deal_id) then return jsonb_build_object('status','VERIFIED');end if;
 if i.consumed_at is not null or i.expires_at<=now() or not buyer_internal.invite_relationship(i) then return jsonb_build_object('status','UNAVAILABLE');end if;
 if i.claimed_telegram_id is not null and i.claimed_telegram_id<>p_telegram then return jsonb_build_object('status','UNAVAILABLE');end if;
 if i.claimed_telegram_id is null then
   update public.buyer_portal_invites set claimed_telegram_id=p_telegram,claim_code=upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)) where id=i.id returning * into i;
   insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('TELEGRAM_APPROVAL_REQUESTED',i.id,i.lead_id,p_telegram);
 end if;
 return jsonb_build_object('status','PENDING','code',i.claim_code);
end $$;
create function public.buyer_portal_approve_connection(p_invite uuid,p_deal integer,p_actor integer,p_telegram bigint,p_code text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare i public.buyer_portal_invites; b public.buyer_portal_bindings; l public.leads;
begin
 select * into i from public.buyer_portal_invites where id=p_invite and deal_id=p_deal for update;
 if not found or i.revoked_at is not null or i.consumed_at is not null or i.expires_at<=now() or i.claimed_telegram_id is distinct from p_telegram or i.claim_code is distinct from p_code or not buyer_internal.invite_relationship(i) then raise exception 'BUYER_INVITE_UNAVAILABLE';end if;
 if not exists(select 1 from public.users u join public.deals d on d.id=p_deal where u.id=p_actor and u.is_active=1 and (u.role in ('ADMIN','DIRECTOR') or (u.role='SALES_MANAGER' and d.responsible_user_id=u.id))) then raise exception 'BUYER_ACCESS_DENIED';end if;
 perform pg_advisory_xact_lock(71201,i.lead_id);
 perform pg_advisory_xact_lock(hashtextextended('buyer-tg:'||p_telegram::text,0));
 select * into l from public.leads where id=i.lead_id for share;
 if exists(select 1 from public.buyer_portal_bindings where revoked_at is null and ((lead_id=i.lead_id and telegram_id<>p_telegram) or (telegram_id=p_telegram and lead_id<>i.lead_id))) then raise exception 'BUYER_BINDING_REQUIRES_STAFF_REVIEW';end if;
 select * into b from public.buyer_portal_bindings where lead_id=i.lead_id and telegram_id=p_telegram and revoked_at is null;
 if not found then insert into public.buyer_portal_bindings(lead_id,telegram_id,phone_snapshot) values(i.lead_id,p_telegram,l.phone) returning * into b;end if;
 insert into public.buyer_portal_grants(binding_id,deal_id,owner_lead_id,participant_id) values(b.id,i.deal_id,i.owner_lead_id,i.participant_id) on conflict(binding_id,deal_id) where revoked_at is null do nothing;
 update public.buyer_portal_invites set consumed_at=now(),approved_by=p_actor where id=i.id;
 insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id,actor_user_id) values('TELEGRAM_APPROVED_BY_STAFF',i.id,i.lead_id,p_telegram,p_actor);
 return jsonb_build_object('status','VERIFIED');
end $$;
revoke all on function public.buyer_portal_request_connection(text,bigint),public.buyer_portal_approve_connection(uuid,integer,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.buyer_portal_request_connection(text,bigint),public.buyer_portal_approve_connection(uuid,integer,integer,bigint,text) to service_role;
