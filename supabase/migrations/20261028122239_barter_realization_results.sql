-- Non-cash financial results are separate from cash receipt/expense documents.
create table public.barter_realization_results (
 id uuid primary key default gen_random_uuid(),
 result_cash_desk_id uuid not null references public.dictionaries(id),
 source_cash_desk_id uuid not null references public.dictionaries(id),
 purchase_payment_id integer not null references public.payments(id),
 sale_transfer_id uuid not null references public.cash_transfers(id),
 reclassified_transfer_id uuid not null unique references public.cash_transfers(id),
 reclassified_payment_id integer not null unique references public.payments(id),
 reclassified_expense_id integer not null unique references public.expenses(id),
 asset_name text not null,
 realization_date date not null,
 cost_tjs_minor bigint not null check(cost_tjs_minor>0),
 proceeds_tjs_minor bigint not null check(proceeds_tjs_minor>=0),
 selling_cost_tjs_minor bigint not null default 0 check(selling_cost_tjs_minor>=0),
 exchange_rate numeric not null check(exchange_rate>0),
 result_tjs_minor bigint generated always as (proceeds_tjs_minor-cost_tjs_minor-selling_cost_tjs_minor) stored,
 result_usd_minor bigint generated always as (round((proceeds_tjs_minor-cost_tjs_minor-selling_cost_tjs_minor)/exchange_rate)::bigint) stored,
 source_currency text not null check(source_currency in ('USD','TJS')),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','VOIDED')),
 created_at timestamptz not null default now(),
 created_by integer not null references public.users(id),
 source_snapshot jsonb not null,
 check(result_cash_desk_id<>source_cash_desk_id)
);
alter table public.barter_realization_results enable row level security;
revoke all on public.barter_realization_results from public,anon,authenticated;
grant select,insert,update,delete on public.barter_realization_results to service_role;
create index barter_realization_results_result_desk_idx on public.barter_realization_results(result_cash_desk_id);
create index barter_realization_results_source_desk_idx on public.barter_realization_results(source_cash_desk_id);
comment on table public.barter_realization_results is 'Non-cash sale result; linked legacy loss transfer is reclassified for cashflow reporting, original documents retained for audit.';
