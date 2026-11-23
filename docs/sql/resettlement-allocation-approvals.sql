-- Additive schema only; no existing contracts or payments are updated.
create table if not exists public.resettlement_allocation_approvals (
 id bigint generated always as identity primary key,
 case_id bigint not null references public.resettlement_cases(id),
 approval_version integer not null check (approval_version > 0),
 payable_total_minor bigint not null check (payable_total_minor >= 0),
 supporting_document_ref text not null check (length(trim(supporting_document_ref)) > 0),
 approved_by integer not null,
 approved_at timestamptz not null default now(),
 unique(case_id, approval_version)
);
create table if not exists public.resettlement_allocation_lines (
 id bigint generated always as identity primary key,
 approval_id bigint not null references public.resettlement_allocation_approvals(id),
 deal_id integer not null references public.deals(id),
 allocated_minor bigint not null check (allocated_minor >= 0),
 unique(approval_id, deal_id)
);
alter table public.resettlement_allocation_approvals enable row level security;
alter table public.resettlement_allocation_lines enable row level security;
revoke all on public.resettlement_allocation_approvals from anon, authenticated;
revoke all on public.resettlement_allocation_lines from anon, authenticated;
revoke all on sequence public.resettlement_allocation_approvals_id_seq from anon, authenticated;
revoke all on sequence public.resettlement_allocation_lines_id_seq from anon, authenticated;
-- Allocation totals and membership must be validated atomically in a future transactional RPC before writes are enabled.
