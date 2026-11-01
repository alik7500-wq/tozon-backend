-- Draft only. Apply after webhook processor is implemented and reviewed.
-- Store Meta webhook events durably before returning HTTP 200.
create table if not exists public.tozon_instagram_webhook_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  instagram_user_id text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','processed','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  constraint instagram_webhook_event_key_length check (length(event_key) between 1 and 128)
);
create index if not exists tozon_instagram_webhook_events_pending_idx
  on public.tozon_instagram_webhook_events (received_at)
  where status in ('pending','failed');
alter table public.tozon_instagram_webhook_events enable row level security;
revoke all on public.tozon_instagram_webhook_events from anon, authenticated;
revoke all on sequence public.tozon_instagram_webhook_events_id_seq from anon, authenticated;
grant select, insert, update on public.tozon_instagram_webhook_events to service_role;
grant usage, select on sequence public.tozon_instagram_webhook_events_id_seq to service_role;
