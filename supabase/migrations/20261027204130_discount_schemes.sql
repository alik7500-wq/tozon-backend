-- Configurable discounts for new apartment sales; existing deals remain unchanged.
create table public.discount_schemes (
 id uuid primary key default gen_random_uuid(),
 project_id integer not null references public.projects(id) on delete cascade,
 name text not null check (length(trim(name)) between 1 and 100),
 rules jsonb not null check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) between 1 and 30),
 is_active boolean not null default true,
 starts_on date,
 ends_on date,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (starts_on is null or ends_on is null or starts_on <= ends_on)
);
alter table public.discount_schemes enable row level security;
revoke all on public.discount_schemes from public, anon, authenticated;
grant select, insert, update, delete on public.discount_schemes to service_role;
create index discount_schemes_project_id_idx on public.discount_schemes(project_id);
alter table public.deals add column discount_snapshot jsonb check (discount_snapshot is null or jsonb_typeof(discount_snapshot) = 'object');
comment on column public.deals.discount_snapshot is 'Immutable sale-time copy of discount terms; scheme edits do not recalculate existing contracts.';
insert into public.discount_schemes(project_id,name,rules)
select id, 'Тозон Плаза — стандартные условия', '[{"payment_percent":0,"discount_percent":0,"months":30},{"payment_percent":5,"discount_percent":2.86,"months":30},{"payment_percent":15,"discount_percent":7.14,"months":30},{"payment_percent":30,"discount_percent":11.43,"months":30},{"payment_percent":50,"discount_percent":17.14,"months":30},{"payment_percent":100,"discount_percent":21.43,"months":0}]'::jsonb
from public.projects where name = 'ЖК TOZON PLAZA';
