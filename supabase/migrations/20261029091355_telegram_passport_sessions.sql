-- Separate from financial subscribers: no foreign keys/triggers granting finance access.
create table public.telegram_passport_sessions (
 id uuid primary key default gen_random_uuid(),
 user_id integer not null references public.users(id) on delete cascade,
 token_hash text not null unique check(length(token_hash)=64),
 telegram_id text,
 telegram_name text,
 status text not null default 'PENDING' check(status in ('PENDING','PAIRING','UPLOAD','PROCESSING','REVIEW','READY','CONSUMED','CANCELLED')),
 file_ids jsonb not null default '[]'::jsonb check(jsonb_typeof(file_ids)='array' and jsonb_array_length(file_ids)<=4),
 result jsonb,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null
);
alter table public.telegram_passport_sessions enable row level security;
revoke all on public.telegram_passport_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_passport_sessions to service_role;
create index telegram_passport_expiry on public.telegram_passport_sessions(expires_at);
create unique index telegram_passport_active_chat on public.telegram_passport_sessions(telegram_id)
 where status in ('PAIRING','UPLOAD','PROCESSING','REVIEW','READY');
