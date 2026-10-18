-- Sidecar analytics only: no updates/triggers on expenses, payments or cash balances.
create table public.cost_building_bases (
 building_id integer primary key references public.buildings(id),
 sellable_area_m2 numeric(14,2) not null check(sellable_area_m2>0),
 reason text not null check(length(trim(reason)) between 3 and 2000),
 version integer not null default 1,
 updated_by integer not null references public.users(id),
 updated_at timestamptz not null default now()
);
create table public.cost_expense_allocations (
 expense_id integer primary key references public.expenses(id) on delete cascade,
 mode text not null check(mode in ('DIRECT','SHARED','EXCLUDED','UNASSIGNED')),
 shares jsonb not null default '[]',
 reason text not null check(length(trim(reason)) between 3 and 2000),
 version integer not null default 1,
 updated_by integer not null references public.users(id),
 updated_at timestamptz not null default now()
);
create table public.cost_audit (
 id bigint generated always as identity primary key,
 entity text not null check(entity in ('BASIS','ALLOCATION')),
 entity_id integer not null,
 before_data jsonb,
 after_data jsonb,
 actor_id integer not null references public.users(id),
 created_at timestamptz not null default now()
);
create index cost_audit_entity_idx on public.cost_audit(entity,entity_id,id desc);
alter table public.cost_building_bases enable row level security;
alter table public.cost_expense_allocations enable row level security;
alter table public.cost_audit enable row level security;
revoke all on public.cost_building_bases,public.cost_expense_allocations,public.cost_audit from public,anon,authenticated;
grant select,insert,update,delete on public.cost_building_bases,public.cost_expense_allocations to service_role;
grant select,insert on public.cost_audit to service_role;
grant usage,select on sequence public.cost_audit_id_seq to service_role;

create function public.cost_require_writer(p_actor integer) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.users where id=p_actor and is_active::text in ('true','1') and
   (role='ADMIN' or permissions ? '*' or (permissions ? 'finance.costs' and permissions ? 'finance.costs.write')))
 then raise exception 'COST_ACCESS_DENIED'; end if;
end $$;

create function public.cost_save_basis(p_building integer,p_area numeric,p_reason text,p_expected integer,p_actor integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old_row public.cost_building_bases; new_row public.cost_building_bases;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101801,p_building);
 if not exists(select 1 from public.buildings where id=p_building and archived_at is null)
 then raise exception 'Блок не найден или архивирован'; end if;
 if p_area is null or p_area<=0 or p_area>10000000 or p_area<>round(p_area,2)
    or p_reason is null or length(trim(p_reason)) not between 3 and 2000 or p_expected is null
 then raise exception 'Укажите продаваемую площадь и основание'; end if;
 select * into old_row from public.cost_building_bases where building_id=p_building for update;
 if coalesce(old_row.version,0)<>p_expected then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 insert into public.cost_building_bases(building_id,sellable_area_m2,reason,updated_by)
 values(p_building,p_area,trim(p_reason),p_actor)
 on conflict(building_id) do update set sellable_area_m2=excluded.sellable_area_m2,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_building_bases.version+1 returning * into new_row;
 insert into public.cost_audit(entity,entity_id,before_data,after_data,actor_id)
 values('BASIS',p_building,case when old_row.building_id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $$;

create function public.cost_save_allocation(p_expense integer,p_mode text,p_buildings integer[],p_reason text,p_expected integer,p_actor integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old_row public.cost_expense_allocations; new_row public.cost_expense_allocations; e public.expenses;
 shares_data jsonb='[]'; n integer; project_count integer;
begin
 perform public.cost_require_writer(p_actor);
 perform pg_catalog.pg_advisory_xact_lock(6101802,p_expense);
 select * into e from public.expenses where id=p_expense for share;
 if not found then raise exception 'РКО не найден'; end if;
 if p_mode is null or p_mode not in ('DIRECT','SHARED','EXCLUDED','UNASSIGNED') or p_reason is null
 or length(trim(p_reason)) not between 3 and 2000 or p_expected is null or p_buildings is null
 then raise exception 'Некорректное распределение'; end if;
 if p_mode in ('DIRECT','SHARED') then
  if e.voided_at is not null or coalesce(e.status,'ACTIVE') in ('VOIDED','CANCELLED','REVERSED') or e.transfer_id is not null
   or coalesce(e.operation_type,'') like '%TRANSFER%' or e.operation_type='CONVERSION'
   or e.category in ('Внутренние перемещения между кассами','INTERNAL_TRANSFER','Конвертация валюты','CURRENCY_CONVERSION')
   or (e.conversion_id is not null and e.conversion_expense_id is null)
   or exists(select 1 from public.construction_documents where expense_id=p_expense and kind='ADVANCE_ISSUE' and status='POSTED')
  then raise exception 'Перемещение, обмен, подотчёт или аннулированный РКО не включаются в затраты'; end if;
  n=cardinality(p_buildings);
  if n is null or n>100 or (p_mode='DIRECT' and n<>1) or (p_mode='SHARED' and n<2)
   or n<>(select count(distinct x) from unnest(p_buildings) x)
  then raise exception 'Выберите блоки без повторений'; end if;
  if n<>(select count(*) from public.buildings where id=any(p_buildings) and archived_at is null)
  then raise exception 'Блок не найден или архивирован'; end if;
  select count(distinct project_id) into project_count from public.buildings where id=any(p_buildings);
  if project_count<>1 then raise exception 'Общие расходы распределяются внутри одного проекта'; end if;
  if p_mode='DIRECT' then shares_data=jsonb_build_array(jsonb_build_object('building_id',p_buildings[1],'weight',1));
  else
   -- Snapshot confirmed areas. Later basis changes do not silently reallocate old RKO.
   perform 1 from public.cost_building_bases where building_id=any(p_buildings) order by building_id for share;
   if n<>(select count(*) from public.cost_building_bases where building_id=any(p_buildings))
   then raise exception 'Сначала подтвердите продаваемую площадь всех выбранных блоков'; end if;
   select jsonb_agg(jsonb_build_object('building_id',building_id,'weight',sellable_area_m2,'basis_version',version) order by building_id)
   into shares_data from public.cost_building_bases where building_id=any(p_buildings);
  end if;
 elsif cardinality(p_buildings)<>0 then raise exception 'Для исключённого/нераспределённого РКО блоки не указываются';
 end if;
 select * into old_row from public.cost_expense_allocations where expense_id=p_expense for update;
 if coalesce(old_row.version,0)<>p_expected then raise exception 'VERSION_CONFLICT: Обновите данные'; end if;
 insert into public.cost_expense_allocations(expense_id,mode,shares,reason,updated_by)
 values(p_expense,p_mode,shares_data,trim(p_reason),p_actor)
 on conflict(expense_id) do update set mode=excluded.mode,shares=excluded.shares,reason=excluded.reason,
 updated_by=p_actor,updated_at=now(),version=cost_expense_allocations.version+1 returning * into new_row;
 insert into public.cost_audit(entity,entity_id,before_data,after_data,actor_id)
 values('ALLOCATION',p_expense,case when old_row.expense_id is null then null else to_jsonb(old_row) end,to_jsonb(new_row),p_actor);
 return to_jsonb(new_row);
end $$;

revoke all on function public.cost_require_writer(integer),public.cost_save_basis(integer,numeric,text,integer,integer),public.cost_save_allocation(integer,text,integer[],text,integer,integer) from public,anon,authenticated;
grant execute on function public.cost_require_writer(integer),public.cost_save_basis(integer,numeric,text,integer,integer),public.cost_save_allocation(integer,text,integer[],text,integer,integer) to service_role;
