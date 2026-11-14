-- Confirmed owner identity covers all current SIGNED contracts of the same CRM lead.
-- Never infer identity from phone equality across leads; never restore revoked grants.
alter function public.buyer_portal_contracts(bigint) rename to buyer_portal_linked_contracts;
revoke all on function public.buyer_portal_linked_contracts(bigint) from public,anon,authenticated;

create function public.buyer_portal_contracts(p_telegram_id bigint) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
begin
  insert into public.buyer_portal_grants(binding_id,deal_id,owner_lead_id)
  select b.id,d.id,b.lead_id
  from public.buyer_portal_bindings b
  join public.leads l on l.id=b.lead_id and l.phone=b.phone_snapshot
  join public.deals d on d.lead_id=b.lead_id and d.status='SIGNED'
  where b.telegram_id=p_telegram_id and b.revoked_at is null
    and exists (
      select 1 from public.buyer_portal_access(p_telegram_id) a
      join public.buyer_portal_grants anchor on anchor.binding_id=a.binding_id and anchor.deal_id=a.deal_id
      where a.binding_id=b.id and anchor.participant_id is null and anchor.revoked_at is null
        and anchor.owner_lead_id=b.lead_id
    )
    and not exists (
      select 1 from public.buyer_portal_grants history where history.binding_id=b.id and history.deal_id=d.id
    )
  on conflict(binding_id,deal_id) where revoked_at is null do nothing;
  return public.buyer_portal_linked_contracts(p_telegram_id);
end $$;
revoke all on function public.buyer_portal_contracts(bigint) from public,anon,authenticated;
grant execute on function public.buyer_portal_linked_contracts(bigint),public.buyer_portal_contracts(bigint) to service_role;
