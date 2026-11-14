-- All grants, identity and financial rows are read in one MVCC statement snapshot.
-- Never use the staff deal response: it includes passport data and internal attribution.
create function public.buyer_portal_contracts(p_telegram_id bigint)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'contractNumber',d.contract_number,
   'projectName',p.name,'unitNumber',u.unit_number,'kind',u.unit_kind) order by d.deal_date desc,d.id desc),'[]'::jsonb)
 from public.buyer_portal_access(p_telegram_id) a join public.deals d on d.id=a.deal_id
 join public.units u on u.id=d.unit_id join public.floors f on f.id=u.floor_id
 join public.sections s on s.id=f.section_id join public.buildings b on b.id=s.building_id
 join public.projects p on p.id=b.project_id
$$;

create function public.buyer_portal_contract_snapshot(p_telegram_id bigint,p_deal_id integer)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'deal',jsonb_build_object('id',d.id,'contract_number',d.contract_number,'deal_date',d.deal_date,
   'status',d.status,'currency',d.currency,'final_price_minor',d.final_price_minor,
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
revoke all on function public.buyer_portal_contracts(bigint),public.buyer_portal_contract_snapshot(bigint,integer) from public,anon,authenticated;
grant execute on function public.buyer_portal_contracts(bigint),public.buyer_portal_contract_snapshot(bigint,integer) to service_role;
