-- Existing inventory remains residential; new units have an explicit purpose.
alter table public.units
  add column unit_kind text not null default 'APARTMENT'
  constraint units_unit_kind_check check (unit_kind in ('APARTMENT', 'COMMERCIAL', 'PARKING'));
comment on column public.units.unit_kind is 'Назначение объекта продажи: квартира, коммерция или машино-место.';
notify pgrst, 'reload schema';
