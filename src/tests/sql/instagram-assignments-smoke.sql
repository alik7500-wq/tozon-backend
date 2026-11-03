-- Runs ONLY against disposable PostgreSQL in GitHub Actions.
create schema if not exists public;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.users (id integer primary key);
insert into public.users(id) values (1),(2),(3);
\i docs/instagram-conversation-assignments-proposal.sql
insert into public.avj_tenants(id,name) values ('tozon','TOZON'),('other','Other');
insert into public.avj_tenant_users(tenant_id,user_id)
values ('tozon',1),('tozon',2),('other',3);
insert into public.avj_tenant_instagram_accounts(tenant_id,instagram_account_id)
values ('tozon','17841447499018452'),('other','17841447499018453');
insert into public.tozon_instagram_conversation_assignments
(instagram_account_id,contact_id,tenant_id,assigned_user_id,assigned_by_user_id)
values ('17841447499018452','123456789','tozon',2,1);
do $$
begin
  begin
    insert into public.tozon_instagram_conversation_assignments
    (instagram_account_id,contact_id,tenant_id,assigned_user_id,assigned_by_user_id)
    values ('17841447499018452','123456790','tozon',3,1);
    raise exception 'Cross-tenant manager accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.tozon_instagram_conversation_assignments
    (instagram_account_id,contact_id,tenant_id,assigned_user_id,assigned_by_user_id)
    values ('17841447499018452','123456791','tozon',2,3);
    raise exception 'Cross-tenant assigning actor accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.tozon_instagram_conversation_assignments
    (instagram_account_id,contact_id,tenant_id,assigned_user_id,assigned_by_user_id)
    values ('17841447499018453','123456792','tozon',2,1);
    raise exception 'Cross-tenant Instagram account accepted';
  exception when foreign_key_violation then null;
  end;
  if exists (select 1 from pg_policies where schemaname='public' and tablename in
    ('avj_tenants','avj_tenant_users','avj_tenant_instagram_accounts','tozon_instagram_conversation_assignments')) then
    raise exception 'Unexpected public RLS policies';
  end if;
  if exists (select 1 from information_schema.role_table_grants where grantee in ('anon','authenticated')
    and table_schema='public' and table_name in
    ('avj_tenants','avj_tenant_users','avj_tenant_instagram_accounts','tozon_instagram_conversation_assignments')) then
    raise exception 'Public table grants detected';
  end if;
end $$;
