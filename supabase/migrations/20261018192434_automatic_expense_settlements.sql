-- The live cash document is the sole source for automatic settlements.
-- No duplicate cash movement or mutable copy of its amount is created.
alter table public.expenses
 add column settlement_party_id uuid references public.construction_parties(id),
 add column settlement_account text check(settlement_account in ('PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED')),
 add column settlement_updated_by integer references public.users(id),
 add constraint expense_settlement_pair check((settlement_party_id is null)=(settlement_account is null));
create index expense_settlement_party on public.expenses(settlement_party_id) where settlement_party_id is not null;
create table public.construction_expense_settlement_audit (
 id bigint generated always as identity primary key,
 expense_id integer not null,
 actor_id integer references public.users(id),
 operation text not null,
 before_data jsonb,
 after_data jsonb,
 created_at timestamptz not null default now()
);
alter table public.construction_expense_settlement_audit enable row level security;
revoke all on public.construction_expense_settlement_audit from public,anon,authenticated,service_role;
grant select,insert on public.construction_expense_settlement_audit to service_role;
grant usage,select on sequence public.construction_expense_settlement_audit_id_seq to service_role;

create view public.construction_expense_settlements with(security_invoker=true) as
 select e.id,e.settlement_party_id as party_id,e.settlement_account as account,e.currency,e.expense_date as doc_date,
 (e.amount_minor::numeric/100)*case when e.settlement_account in ('PAYABLE','ADVANCE_RECEIVED') then -1 else 1 end as amount,
 e.reference,e.description,e.created_by_user_id,e.created_at
 from public.expenses e
 where e.settlement_party_id is not null and coalesce(e.status,'ACTIVE')='ACTIVE' and e.voided_at is null;
revoke all on public.construction_expense_settlements from public,anon,authenticated,service_role;
grant select on public.construction_expense_settlements to service_role;

create function public.construction_validate_expense_settlement() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin
 if new.settlement_party_id is not null then
  if not exists(select 1 from public.construction_parties where id=new.settlement_party_id and kind<>'EMPLOYEE' and active) then
   -- Archiving a party must not prevent voiding an existing cash document.
   if tg_op='INSERT' or new.settlement_party_id is distinct from old.settlement_party_id or coalesce(new.status,'ACTIVE')='ACTIVE' and new.voided_at is null then
    raise exception 'Выберите активного поставщика, подрядчика или дебитора';
   end if;
  end if;
  if new.currency not in ('TJS','USD') or new.amount_minor<=0 or new.expense_date<(select start_date from public.construction_settings where id=1)
   or new.transfer_id is not null or coalesce(new.operation_type,'STANDARD') not in ('STANDARD','EXPENSE')
   or new.category in ('Конвертация валюты','Внутренние перемещения между кассами','CURRENCY_CONVERSION','INTERNAL_TRANSFER')
   or (new.conversion_id is not null and new.conversion_expense_id is null) then
   raise exception 'Связать с расчётами можно только расходный РКО с даты начала учёта';
  end if;
  if exists(select 1 from public.construction_documents where expense_id=new.id and status<>'CANCELLED') then
   raise exception 'РКО уже связан с документом строительного учёта. Повторная оплата запрещена';
  end if;
 end if;
 return new;
end $$;
create trigger construction_validate_expense_settlement before insert or update on public.expenses
 for each row execute function public.construction_validate_expense_settlement();

create function public.construction_prevent_double_expense_settlement() returns trigger
 language plpgsql security invoker set search_path='' as $$
declare party uuid;
begin
 if new.expense_id is not null and new.status<>'CANCELLED' then
  select settlement_party_id into party from public.expenses where id=new.expense_id for update;
  if party is not null then raise exception 'Этот РКО уже автоматически учтён в расчётах с контрагентом'; end if;
 end if;
 if new.kind='OPENING_SETTLEMENT' and new.status='POSTED' and exists(select 1 from public.construction_expense_settlements where party_id=new.party_id and currency=new.currency and account=new.balance_type) then
  raise exception 'Начальный остаток вводится до движения по РКО';
 end if;
 return new;
end $$;
create trigger construction_prevent_double_expense_settlement before insert or update on public.construction_documents
 for each row execute function public.construction_prevent_double_expense_settlement();

create function public.construction_audit_expense_settlement() returns trigger
 language plpgsql security invoker set search_path='' as $$
declare before_row jsonb; after_row jsonb;
begin
 if tg_op<>'INSERT' then before_row=to_jsonb(old); end if;
 if tg_op<>'DELETE' then after_row=to_jsonb(new); end if;
 if coalesce(before_row->>'settlement_party_id',after_row->>'settlement_party_id') is not null
 and (tg_op<>'UPDATE' or (before_row-array['reference','updated_at','settlement_updated_by']) is distinct from (after_row-array['reference','updated_at','settlement_updated_by'])) then
  insert into public.construction_expense_settlement_audit(expense_id,actor_id,operation,before_data,after_data)
  values(coalesce((after_row->>'id')::integer,(before_row->>'id')::integer),case when tg_op='DELETE' then null else (after_row->>'settlement_updated_by')::integer end,tg_op,before_row,after_row);
 end if;
 return coalesce(new,old);
end $$;
create trigger construction_audit_expense_settlement after insert or update or delete on public.expenses
 for each row execute function public.construction_audit_expense_settlement();
revoke all on function public.construction_validate_expense_settlement(),public.construction_prevent_double_expense_settlement(),public.construction_audit_expense_settlement() from public,anon,authenticated;

-- Wrap the existing cash RPC in one transaction, including optional USD->TJS
-- conversion. A failed settlement validation rolls back every cash leg.
create function public.create_expense_with_settlement(p_data jsonb,p_actor integer) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare e public.expenses; u public.users; r jsonb; fx_out jsonb; fx_in integer;
 key text:=trim(p_data->>'idempotency_key'); party uuid:=(p_data->>'settlement_party_id')::uuid;
 account text:=p_data->>'settlement_account'; cur text:=p_data->>'currency';
 qty numeric:=(p_data->>'amount')::numeric; rate numeric:=(p_data->>'exchange_rate')::numeric;
 desk uuid:=(p_data->>'cash_desk_id')::uuid; dt date:=(p_data->>'expense_date')::date;
 fx_id uuid; source_qty numeric; converted boolean:=false;
begin
 select * into u from public.users where id=p_actor and to_jsonb(users)->>'is_active' in ('true','1');
 if not found then raise exception 'Нет доступа' using errcode='42501'; end if;
 if key is null or length(key) not between 1 and 100 or qty is null or qty<=0 or qty<>round(qty,2) or qty*100>2147483647
  or party is null or account is null or account not in ('PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED')
  or cur is null or cur not in ('TJS','USD') or dt is null or desk is null then raise exception 'Проверьте сумму, кассу, дату и контрагента РКО'; end if;
 if cur='TJS' and (rate is null or rate<=0) then raise exception 'Укажите исторический курс TJS за 1 USD'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('expense-settlement:'||key,0));
 select * into e from public.expenses where idempotency_key=key for update;
 if found then
  if e.created_by_user_id<>p_actor or e.cash_desk_id<>desk or e.amount_minor<>qty*100 or e.currency<>cur
   or e.settlement_party_id is distinct from party or e.settlement_account is distinct from account or e.expense_date<>dt then
   raise exception 'Ключ РКО уже использован для другой операции' using errcode='23505';
  end if;
  return to_jsonb(e)||jsonb_build_object('amount',qty,'idempotent',true);
 end if;
 if coalesce(p_data->>'settlement_method','CASH')<>'CASH' or coalesce((p_data->>'is_transfer')::boolean,false) then raise exception 'Используйте обычный расходный РКО'; end if;
 if cur='TJS' and coalesce((p_data->>'auto_convert')::boolean,false) then
  if coalesce(p_data->>'source_currency','USD')<>'USD' then raise exception 'Автоконвертация поддерживает источник USD'; end if;
  fx_id=gen_random_uuid(); source_qty=round(qty/rate,2);
  if source_qty<=0 then raise exception 'Сумма слишком мала для конвертации'; end if;
  fx_out=public.create_atomic_expense(desk,(source_qty*100)::bigint,'USD',dt,'Конвертация валюты','Касса TJS (Автоконвертация)',
   'Автоконвертация для оплаты контрагенту',p_actor,coalesce(p_data->>'method','CASH'),rate,source_qty,null,key||':FX');
  update public.expenses set conversion_id=fx_id,operation_type='CONVERSION',reference='КОНВ-'||id where id=(fx_out->>'expense_id')::integer;
  insert into public.payments(cash_desk_id,amount_minor,currency,payment_date,method,payer_name,comment,created_by_user_id,conversion_id,status,operation_type,exchange_rate,amount_tjs,amount_usd,idempotency_key)
  values(desk,(qty*100)::integer,'TJS',dt,coalesce(p_data->>'method','CASH'),'Касса USD (Автоконвертация)','Автоконвертация для оплаты контрагенту',p_actor,fx_id,'ACTIVE','CONVERSION',rate,qty,source_qty,key||':FX-IN') returning id into fx_in;
  update public.payments set reference='ПКО-КОНВ-'||id where id=fx_in;
  converted=true;
 end if;
 r=public.create_atomic_expense(desk,(qty*100)::bigint,cur,dt,coalesce(p_data->>'category','Прочее'),p_data->>'recipient',p_data->>'description',p_actor,
  coalesce(p_data->>'method','CASH'),rate,case when cur='USD' then qty else round(qty/rate,2) end,case when cur='TJS' then qty else null end,key);
 if coalesce((r->>'idempotent')::boolean,false) then raise exception 'РКО уже создан другим запросом. Обновите данные' using errcode='23505'; end if;
 update public.expenses set settlement_party_id=party,settlement_account=account,settlement_updated_by=p_actor,
  conversion_id=fx_id,conversion_expense_id=case when converted then (fx_out->>'expense_id')::integer else null end,
  reference=coalesce(nullif(trim(p_data->>'reference'),''),reference)
 where id=(r->>'expense_id')::integer returning * into e;
 r=to_jsonb(e)||jsonb_build_object('amount',qty);
 if converted then r=r||jsonb_build_object('conversion',jsonb_build_object('has_conversion',true,'conv_expense_id',(fx_out->>'expense_id')::integer,
  'conv_expense_reference','КОНВ-'||(fx_out->>'expense_id'),'conv_payment_id',fx_in,'conv_payment_reference','ПКО-КОНВ-'||fx_in,
  'main_expense_id',e.id,'main_expense_reference',e.reference,'source_currency','USD','source_amount_usd',source_qty,'target_currency','TJS','target_amount_tjs',qty,'exchange_rate',rate)); end if;
 return r;
end $$;
revoke all on function public.create_expense_with_settlement(jsonb,integer) from public,anon,authenticated;
grant execute on function public.create_expense_with_settlement(jsonb,integer) to service_role;

notify pgrst, 'reload schema';
