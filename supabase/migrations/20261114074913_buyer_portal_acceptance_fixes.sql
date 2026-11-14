-- Consistent advisory/OTP lock ordering prevents a confirm-vs-resend lock cycle.
create or replace function public.buyer_portal_confirm_otp(p_id uuid,p_telegram_id bigint,p_code_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.buyer_portal_otp; i public.buyer_portal_invites; d public.deals; l public.leads; b public.buyer_portal_bindings;
begin
  -- Lock invite first, matching prepare; this serializes two simultaneous redemptions.
  select v.* into i from public.buyer_portal_invites v join public.buyer_portal_otp o on o.invite_id=v.id where o.id=p_id for update of v;
  if not found then return jsonb_build_object('status','UNAVAILABLE'); end if;
  -- Match prepare/unlink ordering before locking an OTP row.
  perform pg_advisory_xact_lock(71201,i.lead_id);
  perform pg_advisory_xact_lock(hashtextextended('buyer-tg:' || p_telegram_id::text,0));
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

create function public.buyer_portal_touch(p_telegram bigint) returns void
language sql security invoker set search_path=pg_catalog,public as $$
 update public.buyer_portal_bindings b set last_active_at=now() where b.telegram_id=p_telegram and b.revoked_at is null
 and (b.last_active_at is null or b.last_active_at<now()-interval '2 minutes')
 and (exists(select 1 from public.buyer_portal_access(p_telegram) a where a.binding_id=b.id)
 or exists(select 1 from public.buyer_portal_archive_access(p_telegram) a where a.binding_id=b.id))
$$;
create function public.buyer_portal_staff_notices(p_deal integer,p_owner integer) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(item),'[]'::jsonb) from (
 select jsonb_build_object('id',n.id,'kind',n.kind,'status',n.status,'createdAt',n.created_at,'finishedAt',n.finished_at,
 'audience',case when b.lead_id=p_owner then 'OWNER' else 'PARTICIPANT' end) item
 from public.buyer_portal_notices n join public.buyer_portal_bindings b on b.id=n.binding_id
 join public.deals d on d.id=n.deal_id and d.lead_id=p_owner
 where n.deal_id=p_deal and exists(select 1 from public.buyer_portal_grants g where g.binding_id=b.id and g.deal_id=d.id and g.owner_lead_id=p_owner)
 order by n.created_at desc,n.id desc limit 100
 ) recent
$$;
revoke all on function public.buyer_portal_touch(bigint),public.buyer_portal_staff_notices(integer,integer) from public,anon,authenticated;
grant execute on function public.buyer_portal_touch(bigint),public.buyer_portal_staff_notices(integer,integer) to service_role;
