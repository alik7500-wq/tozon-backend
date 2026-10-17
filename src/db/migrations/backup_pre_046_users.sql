-- PRE-RELEASE BACKUP: public.users snapshot
-- Timestamp: 2026-10-16T00:33:05+05:00
-- Target database: yeslzrrcwgcqfxhgbrqk (Supabase Postgres)

-- Constraint definition:
-- users_role_check: CHECK ((role = ANY (ARRAY['ADMIN'::text, 'DIRECTOR'::text, 'SALES_MANAGER'::text, 'FINANCE_MANAGER'::text, 'MANAGER'::text])))

-- User ID 6 state:
-- {"id":6,"name":"Усмонов Саидкодир","email":"zavsklad@tozon.crm","role":"SALES_MANAGER","is_active":1,"permissions":["construction.stock","construction.advance","construction.settlements","finance.expenses"],"created_at":"2026-10-13T06:50:29.580Z","updated_at":"2026-10-13T06:50:29.580Z"}

-- Full JSON snapshot of all 6 users:
/*
[
  {"id":1,"name":"Admin","email":"admin@tozon.crm","role":"ADMIN","is_active":1,"permissions":["analytics.view","analytics.reports","inventory.view","inventory.manage","leads.view","leads.manage","tasks.manage","deals.view","deals.manage","contracts.view","contracts.manage","finance.view","finance.payments","finance.expenses","finance.debtors","finance.cashflow","automation.manage","users.manage","settings.manage"],"created_at":"2026-08-19T12:41:07.128Z","updated_at":"2026-10-06T11:17:53.058Z"},
  {"id":2,"name":"Руководитель Отдела Продаж","email":"director@tozon.tj","role":"DIRECTOR","is_active":1,"permissions":["access.v2","analytics.view","analytics.reports","inventory.view","leads.view","leads.manage","tasks.view","tasks.manage","deals.view","contracts.view","finance.expenses","finance.debtors","automation.view","finance.payments"],"created_at":"2026-08-05T10:00:00.000Z","updated_at":"2026-10-14T10:25:25.923Z"},
  {"id":3,"name":"Менеджер по продажам (Дадочон)","email":"manager1@tozon.tj","role":"SALES_MANAGER","is_active":1,"permissions":["access.v2","inventory.view","leads.view","leads.manage","tasks.view","tasks.manage","deals.view","deals.manage","contracts.view","finance.payments","finance.payments.write","finance.expenses","finance.expenses.write","finance.debtors","automation.view","automation.manage"],"created_at":"2026-08-10T10:00:00.000Z","updated_at":"2026-10-14T09:44:26.533Z"},
  {"id":4,"name":"Финансовый менеджер (Далер)","email":"finance@tozon.tj","role":"FINANCE_MANAGER","is_active":1,"permissions":["access.v2","finance.restricted","analytics.view","analytics.reports","inventory.view","leads.view","tasks.view","deals.view","contracts.view","finance.view","finance.payments","finance.payments.write","finance.expenses","finance.expenses.write","finance.debtors","finance.cashflow","users.view","construction.stock","construction.advance","construction.settlements","construction.settings"],"created_at":"2026-08-12T10:00:00.000Z","updated_at":"2026-10-14T10:49:19.228Z"},
  {"id":5,"name":"Махмуджонов Шерали Шухратович","email":"admin_sh@tozon.crm","role":"ADMIN","is_active":1,"permissions":["access.v2","analytics.view","analytics.reports","inventory.view","inventory.manage","leads.view","leads.manage","tasks.view","tasks.manage","deals.view","deals.manage","contracts.view","contracts.manage","finance.view","finance.payments","finance.payments.write","finance.debtors","automation.view","automation.manage","analytics.view.write","analytics.reports.write","users.view","users.manage"],"created_at":"2026-10-10T05:17:54.702Z","updated_at":"2026-10-14T09:42:53.853Z"},
  {"id":6,"name":"Усмонов Саидкодир","email":"zavsklad@tozon.crm","role":"SALES_MANAGER","is_active":1,"permissions":["construction.stock","construction.advance","construction.settlements","finance.expenses"],"created_at":"2026-10-13T06:50:29.580Z","updated_at":"2026-10-13T06:50:29.580Z"}
]
*/
