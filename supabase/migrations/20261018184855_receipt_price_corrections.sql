-- Corrections preserve the immutable posted source and audit all valuation changes.
create table public.construction_price_corrections (
 id uuid primary key,
 receipt_id uuid not null references public.construction_documents(id),
 version integer not null check(version>0),
 reason text not null check(length(trim(reason)) between 3 and 2000),
 actor_id integer not null references public.users(id),
 created_at timestamptz not null default now(),
 before_lines jsonb not null,
 after_lines jsonb not null,
 ledger_changes jsonb not null,
 unique(receipt_id,version)
);
alter table public.construction_price_corrections enable row level security;
revoke all on public.construction_price_corrections from public,anon,authenticated,service_role;
grant select,insert on public.construction_price_corrections to service_role;

create function public.construction_correct_receipt_price(p_id uuid,p_receipt uuid,p_values jsonb,p_expected integer,p_reason text,p_actor integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 d public.construction_documents; u public.users; previous public.construction_price_corrections;
 entry record; prior record; usage public.cost_material_usages; after_usage public.cost_material_usages;
 old_lines jsonb; new_lines jsonb; changes jsonb:='[]'; version_now integer;
 pos integer:=0; val numeric; qty numeric; balance_value numeric; total numeric; old_total numeric; old_payable numeric;
 result jsonb;
begin
 select * into u from public.users where id=p_actor and to_jsonb(users)->>'is_active' in ('true','1');
 if not found or not (u.role='ADMIN' or coalesce(u.permissions::jsonb,'[]') ?| array['*','construction.settings']) then
  raise exception 'Недостаточно прав для корректировки цены' using errcode='42501';
 end if;
 -- Same posting lock and same cost lock as the existing writers.
 perform 1 from public.construction_settings where id=1 for update;
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into d from public.construction_documents where id=p_receipt for update;
 if not found or d.kind<>'RECEIPT' or d.status<>'POSTED' then raise exception 'Выберите проведённое поступление материалов'; end if;
 select * into previous from public.construction_price_corrections where id=p_id;
 if found then
  if previous.receipt_id<>p_receipt or previous.actor_id<>p_actor or previous.reason<>trim(p_reason)
   or (select jsonb_agg(l->'value' order by n) from jsonb_array_elements(previous.after_lines) with ordinality a(l,n)) is distinct from p_values
  then raise exception 'Идентификатор корректировки уже использован'; end if;
  return to_jsonb(previous);
 end if;
 select coalesce(max(version),0) into version_now from public.construction_price_corrections where receipt_id=p_receipt;
 if p_expected is null or p_expected<>version_now then raise exception 'VERSION_CONFLICT: Цена уже изменена. Обновите данные' using errcode='40001'; end if;
 if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите причину корректировки (3–2000 символов)'; end if;
 if jsonb_typeof(p_values) is distinct from 'array' or jsonb_array_length(p_values)<>jsonb_array_length(d.lines) then raise exception 'Состав строк изменён. Обновите данные'; end if;
 if exists(select 1 from public.construction_report_receipts where receipt_id=p_receipt) then raise exception 'Поступление включено в утверждённый авансовый отчёт. Требуется отдельная корректировка отчёта'; end if;
 select after_lines into old_lines from public.construction_price_corrections where receipt_id=p_receipt order by version desc limit 1;
 old_lines=coalesce(old_lines,d.lines); new_lines=old_lines;
 if (select count(*) from public.construction_stock_entries where document_id=p_receipt)<>jsonb_array_length(d.lines) then raise exception 'Проводки не соответствуют строкам поступления'; end if;
 for entry in select * from public.construction_stock_entries where document_id=p_receipt order by id loop
  if jsonb_typeof(p_values->pos) is distinct from 'number' then raise exception 'Укажите стоимость каждой строки'; end if;
  val=(p_values->>pos)::numeric;
  if val<0 or val>999999999999 or val<>round(val,2) then raise exception 'Стоимость должна быть неотрицательной, до двух знаков после запятой'; end if;
  if entry.quantity<=0 or entry.material_id::text is distinct from d.lines->pos->>'material_id'
    or entry.quantity<>(d.lines->pos->>'quantity')::numeric then raise exception 'Проводки не соответствуют строкам поступления'; end if;
  new_lines=jsonb_set(new_lines,array[pos::text,'value'],to_jsonb(val));
  if val<>entry.value then
   changes=changes||jsonb_build_array(jsonb_build_object('entry_id',entry.id,'before',entry.value,'after',val));
   update public.construction_stock_entries set value=val where id=entry.id;
  end if;
  pos=pos+1;
 end loop;
 if changes='[]'::jsonb then raise exception 'Цена не изменена'; end if;
 select sum((l->>'value')::numeric) into total from jsonb_array_elements(new_lines) l;
 select sum((l->>'value')::numeric) into old_total from jsonb_array_elements(old_lines) l;
 -- Replay weighted-average valuation in original posting order, across warehouses.
 -- Transfer pairs are inserted consecutively by construction_post.
 for entry in
  select e.*,doc.kind from public.construction_stock_entries e join public.construction_documents doc on doc.id=e.document_id
  where e.currency=d.currency and e.material_id in (select (l->>'material_id')::uuid from jsonb_array_elements(d.lines) l)
  order by e.id
 loop
  val=entry.value;
  if entry.quantity<0 then
   select coalesce(sum(quantity),0),coalesce(sum(value),0) into qty,balance_value from public.construction_stock_entries
    where warehouse_id=entry.warehouse_id and material_id=entry.material_id and currency=entry.currency and id<entry.id;
   if qty< -entry.quantity or qty<=0 or balance_value<0 then raise exception 'Нарушена последовательность складских проводок'; end if;
   val=case when qty= -entry.quantity then -balance_value else -round(balance_value*(-entry.quantity)/qty,2) end;
  elsif entry.kind='TRANSFER' then
   select * into prior from public.construction_stock_entries where id=entry.id-1;
   if prior.document_id is distinct from entry.document_id or prior.material_id is distinct from entry.material_id
     or prior.quantity<> -entry.quantity or prior.currency<>entry.currency then raise exception 'Не найдена парная проводка перемещения'; end if;
   val= -prior.value;
  end if;
  if val<>entry.value then
   changes=changes||jsonb_build_array(jsonb_build_object('entry_id',entry.id,'before',entry.value,'after',val));
   update public.construction_stock_entries set value=val where id=entry.id;
   for usage in select * from public.cost_material_usages where stock_entry_id=entry.id for update loop
    if val>=0 then raise exception 'Связанный расход себестоимости не может иметь нулевую стоимость'; end if;
    if exists(select 1 from public.cost_material_payment_links where usage_id=usage.id and status='ACTIVE') then
     raise exception 'Сначала отмените привязки оплат в себестоимости, затем корректируйте цену поступления';
    end if;
    update public.cost_material_usages set amount= -val,version=version+1,updated_by=p_actor,updated_at=now() where id=usage.id returning * into after_usage;
    insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id) values('USAGE',usage.id,to_jsonb(usage),to_jsonb(after_usage),p_actor);
   end loop;
  end if;
 end loop;
 if (select kind from public.construction_parties where id=d.party_id)<>'EMPLOYEE' then
  select coalesce(sum(amount),0) into old_payable from public.construction_settlement_entries where document_id=p_receipt and account='PAYABLE';
  if old_payable<>old_total then raise exception 'Начисление поставщику не соответствует поступлению'; end if;
  delete from public.construction_settlement_entries where document_id=p_receipt and account='PAYABLE';
  if total>0 then insert into public.construction_settlement_entries(document_id,party_id,currency,account,amount) values(p_receipt,d.party_id,d.currency,'PAYABLE',total); end if;
 end if;
 insert into public.construction_price_corrections(id,receipt_id,version,reason,actor_id,before_lines,after_lines,ledger_changes)
 values(p_id,p_receipt,version_now+1,trim(p_reason),p_actor,old_lines,new_lines,changes) returning to_jsonb(construction_price_corrections) into result;
 return result;
end $$;
revoke all on function public.construction_correct_receipt_price(uuid,uuid,jsonb,integer,text,integer) from public,anon,authenticated;
grant execute on function public.construction_correct_receipt_price(uuid,uuid,jsonb,integer,text,integer) to service_role;
