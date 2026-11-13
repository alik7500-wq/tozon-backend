-- Bot visits are identity context only. They NEVER create contract grants or finance subscribers.
create index buyer_portal_audit_telegram_event on public.buyer_portal_audit(telegram_id,event);
create function public.buyer_portal_visit(p_token_hash text,p_telegram_id bigint)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare i public.buyer_portal_invites;
begin
  if p_telegram_id is null or p_telegram_id<=0 then return false; end if;
  select v.* into i from public.buyer_portal_invites v
    join public.deals d on d.id=v.deal_id and d.lead_id=v.lead_id and d.status='SIGNED'
    join public.leads l on l.id=v.lead_id and l.phone=v.phone_snapshot
    where v.token_hash=p_token_hash and v.expires_at>now() and v.consumed_at is null and v.revoked_at is null;
  if not found then return false; end if;
  insert into public.buyer_portal_audit(event,invite_id,lead_id,telegram_id) values('BUYER_OPENED',i.id,i.lead_id,p_telegram_id);
  return true;
end $$;
revoke all on function public.buyer_portal_visit(text,bigint) from public,anon,authenticated;
grant execute on function public.buyer_portal_visit(text,bigint) to service_role;
