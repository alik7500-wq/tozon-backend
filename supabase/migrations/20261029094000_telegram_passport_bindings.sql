-- Verified CRM-to-Telegram identity only; never grants finance subscriptions or cash access.
create table public.telegram_passport_bindings (
 user_id integer primary key references public.users(id) on delete cascade,
 telegram_id text not null unique check(telegram_id ~ '^[1-9][0-9]{0,15}$'),
 telegram_name text not null default '',
 verified_at timestamptz not null default now()
);
alter table public.telegram_passport_bindings enable row level security;
revoke all on public.telegram_passport_bindings from public, anon, authenticated;
grant select,insert,update,delete on public.telegram_passport_bindings to service_role;
