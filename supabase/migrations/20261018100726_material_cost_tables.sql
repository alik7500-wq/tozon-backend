-- Analytical records only. Never insert/update expenses, stock or supplier debt.
create table public.cost_material_usages (
 id uuid primary key,
 stock_entry_id bigint unique references public.construction_stock_entries(id),
 building_id integer not null references public.buildings(id),
 material_kind text not null check(material_kind in ('REBAR','CONCRETE')),
 usage_date date not null,
 quantity numeric(18,4) not null check(quantity>0),
 unit text not null check(length(trim(unit)) between 1 and 30),
 amount numeric(18,2) not null check(amount>0),
 currency text not null check(currency in ('USD','TJS')),
 exchange_rate numeric(14,6) check(exchange_rate>0),
 reason text not null check(length(trim(reason)) between 3 and 2000),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','CANCELLED')),
 version integer not null default 1,
 updated_by integer not null references public.users(id),
 updated_at timestamptz not null default now(),
 check(currency='USD' or exchange_rate is not null)
);
create index cost_material_usages_block_date on public.cost_material_usages(building_id,usage_date);
create table public.cost_material_payment_links (
 id uuid primary key,
 usage_id uuid not null references public.cost_material_usages(id),
 expense_id integer not null references public.expenses(id),
 -- Settlement in the usage's ORIGINAL currency, not today's FX rate.
 paid_amount numeric(18,2) not null check(paid_amount>0),
 cash_usd_minor bigint not null check(cash_usd_minor>0),
 reason text not null check(length(trim(reason)) between 3 and 2000),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','CANCELLED')),
 version integer not null default 1,
 updated_by integer not null references public.users(id),
 updated_at timestamptz not null default now()
);
create unique index cost_material_payment_active_pair on public.cost_material_payment_links(usage_id,expense_id) where status='ACTIVE';
create index cost_material_payment_expense on public.cost_material_payment_links(expense_id);
create table public.cost_material_audit (
 id bigint generated always as identity primary key,
 entity text not null check(entity in ('USAGE','PAYMENT')),
 entity_id uuid not null,
 before_data jsonb,
 after_data jsonb,
 actor_id integer not null references public.users(id),
 created_at timestamptz not null default now()
);
create index cost_material_audit_entity on public.cost_material_audit(entity,entity_id,id desc);
alter table public.cost_material_usages enable row level security;
alter table public.cost_material_payment_links enable row level security;
alter table public.cost_material_audit enable row level security;
revoke all on public.cost_material_usages,public.cost_material_payment_links,public.cost_material_audit from public,anon,authenticated;
grant select,insert,update on public.cost_material_usages,public.cost_material_payment_links to service_role;
grant select,insert on public.cost_material_audit to service_role;
grant usage,select on sequence public.cost_material_audit_id_seq to service_role;

