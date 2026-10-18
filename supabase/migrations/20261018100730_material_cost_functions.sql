create function public.cost_save_material_usage(p_id uuid,p_data jsonb,p_expected integer,p_actor integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old_row public.cost_material_usages; new_row public.cost_material_usages;
 stock public.construction_stock_entries; doc public.construction_documents;
 b integer; source_id bigint; qty numeric; val numeric; fx numeric; cur text; dt date; un text; st text;
begin
 perform public.cost_require_writer(p_actor);
 -- One lock for material mutations: prevents link/save/remove races.
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_usages where id=p_id for update;
 if coalesce(old_row.version,0)<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 b=(p_data->>'building_id')::integer; source_id=(p_data->>'stock_entry_id')::bigint;
 st=coalesce(p_data->>'status','ACTIVE');
 if st not in ('ACTIVE','CANCELLED') or p_data->>'material_kind' is null or p_data->>'material_kind' not in ('REBAR','CONCRETE')
 or p_data->>'reason' is null or length(trim(p_data->>'reason')) not between 3 and 2000
 then raise exception 'Укажите вид материала и основание'; end if;
 if exists(select 1 from public.cost_material_payment_links where usage_id=p_id and status='ACTIVE')
 then raise exception 'Сначала отмените привязки оплат, затем изменяйте расход материала'; end if;
 if not exists(select 1 from public.buildings where id=b and archived_at is null) then raise exception 'Блок не найден или архивирован'; end if;
 if source_id is not null then
  select * into stock from public.construction_stock_entries where id=source_id;
  if not found or stock.quantity>=0 or stock.value>=0 then raise exception 'Выберите списание материала'; end if;
  select * into doc from public.construction_documents where id=stock.document_id;
  if doc.status<>'POSTED' or doc.kind not in ('ISSUE','WRITE_OFF') then raise exception 'Источник не проведён'; end if;
  if doc.project_id is not null and doc.project_id<>(select project_id from public.buildings where id=b) then raise exception 'Источник относится к другому проекту'; end if;
  qty=-stock.quantity; val=-stock.value; cur=stock.currency; dt=doc.doc_date;
  select unit into un from public.construction_materials where id=stock.material_id;
  fx=coalesce(doc.exchange_rate,(p_data->>'exchange_rate')::numeric);
 else
  qty=(p_data->>'quantity')::numeric; val=(p_data->>'amount')::numeric;
  cur=p_data->>'currency'; dt=(p_data->>'usage_date')::date;
  fx=(p_data->>'exchange_rate')::numeric; un=trim(p_data->>'unit');
 end if;
 if qty is null or qty<=0 or qty>1000000000 or qty<>round(qty,4) or val is null or val<=0 or val>1000000000000 or val<>round(val,2)
 or dt is null or dt<'2000-01-01' or cur is null or cur not in ('USD','TJS') or un is null or length(un) not between 1 and 30
 or (cur='TJS' and (fx is null or fx<=0)) then raise exception 'Проверьте количество, стоимость, дату и исторический курс'; end if;
 insert into public.cost_material_usages(id,stock_entry_id,building_id,material_kind,usage_date,quantity,unit,amount,currency,exchange_rate,reason,status,updated_by)
 values(p_id,source_id,b,p_data->>'material_kind',dt,qty,un,val,cur,fx,trim(p_data->>'reason'),st,p_actor)
 on conflict(id) do update set stock_entry_id=excluded.stock_entry_id,building_id=excluded.building_id,material_kind=excluded.material_kind,
 usage_date=excluded.usage_date,quantity=excluded.quantity,unit=excluded.unit,amount=excluded.amount,currency=excluded.currency,
 exchange_rate=excluded.exchange_rate,reason=excluded.reason,status=excluded.status,updated_by=p_actor,updated_at=now(),version=cost_material_usages.version+1
 returning * into new_row;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('USAGE',p_id,case when old_row.id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $$;

create function public.cost_save_material_payment(p_id uuid,p_usage uuid,p_expense integer,p_paid numeric,p_cash bigint,p_reason text,p_expected integer,p_actor integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old_row public.cost_material_payment_links; new_row public.cost_material_payment_links; u public.cost_material_usages;
 e public.expenses; available_cash bigint; used_cash bigint; used_paid numeric;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_payment_links where id=p_id for update;
 if coalesce(old_row.version,0)<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 if old_row.id is not null and (old_row.status<>'ACTIVE' or old_row.usage_id<>p_usage or old_row.expense_id<>p_expense) then raise exception 'Для замены источника отмените привязку'; end if;
 select * into u from public.cost_material_usages where id=p_usage for share;
 if not found or u.status<>'ACTIVE' then raise exception 'Расход материала не найден или отменён'; end if;
 select * into e from public.expenses where id=p_expense for share;
 if not found or e.voided_at is not null or coalesce(e.status,'ACTIVE')<>'ACTIVE' or e.transfer_id is not null
 or coalesce(e.operation_type,'') like '%TRANSFER%' or e.operation_type='CONVERSION'
 or e.category in ('Внутренние перемещения между кассами','INTERNAL_TRANSFER','Конвертация валюты','CURRENCY_CONVERSION')
 or (e.conversion_id is not null and e.conversion_expense_id is null)
 or exists(select 1 from public.construction_documents where expense_id=p_expense and kind='ADVANCE_ISSUE' and status='POSTED')
 then raise exception 'Выберите действующий РКО оплаты поставщику'; end if;
 if p_paid is null or p_paid<=0 or p_paid<>round(p_paid,2) or p_cash is null or p_cash<=0
 or p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите сумму погашения, часть РКО и основание'; end if;
 available_cash=case when e.currency='USD' then e.amount_minor when e.currency='TJS' and e.exchange_rate>0 then round(e.amount_minor/e.exchange_rate)
 when e.currency='TJS' and e.amount_usd>0 then round(e.amount_usd*100) else null end;
 if available_cash is null or available_cash<=0 then raise exception 'У РКО нет исторического курса или USD-оценки'; end if;
 select coalesce(sum(cash_usd_minor),0) into used_cash from public.cost_material_payment_links where expense_id=p_expense and id<>p_id and status='ACTIVE';
 select coalesce(sum(paid_amount),0) into used_paid from public.cost_material_payment_links where usage_id=p_usage and id<>p_id and status='ACTIVE';
 if used_cash+p_cash>available_cash then raise exception 'Привязки превышают сумму РКО'; end if;
 if used_paid+p_paid>u.amount then raise exception 'Погашение превышает стоимость использованного материала'; end if;
 insert into public.cost_material_payment_links(id,usage_id,expense_id,paid_amount,cash_usd_minor,reason,updated_by)
 values(p_id,p_usage,p_expense,p_paid,p_cash,trim(p_reason),p_actor)
 on conflict(id) do update set paid_amount=excluded.paid_amount,cash_usd_minor=excluded.cash_usd_minor,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_material_payment_links.version+1 returning * into new_row;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('PAYMENT',p_id,case when old_row.id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $$;

create function public.cost_remove_material_payment(p_id uuid,p_expected integer,p_reason text,p_actor integer)
returns void language plpgsql security invoker set search_path='' as $$
declare old_row public.cost_material_payment_links;
begin
 perform public.cost_require_writer(p_actor); perform pg_catalog.pg_advisory_xact_lock(6101803,1);
 select * into old_row from public.cost_material_payment_links where id=p_id for update;
 if not found or old_row.status<>'ACTIVE' or old_row.version<>p_expected or p_expected is null then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Укажите основание отмены'; end if;
 update public.cost_material_payment_links set status='CANCELLED',version=version+1,updated_by=p_actor,updated_at=now() where id=p_id;
 insert into public.cost_material_audit(entity,entity_id,before_data,after_data,actor_id)
 values('PAYMENT',p_id,to_jsonb(old_row),jsonb_build_object('removed',true,'reason',trim(p_reason)),p_actor);
end $$;
revoke all on function public.cost_save_material_usage(uuid,jsonb,integer,integer),public.cost_save_material_payment(uuid,uuid,integer,numeric,bigint,text,integer,integer),public.cost_remove_material_payment(uuid,integer,text,integer) from public,anon,authenticated;
grant execute on function public.cost_save_material_usage(uuid,jsonb,integer,integer),public.cost_save_material_payment(uuid,uuid,integer,numeric,bigint,text,integer,integer),public.cost_remove_material_payment(uuid,integer,text,integer) to service_role;
