-- Read-only inventory for the legacy TOZON CRM. No personal contacts or credentials.
-- Run only against the explicitly selected source; never interpret IDs across databases.
WITH unit_project AS (
 SELECT u.id, b.project_id, u.status, u.unit_kind, u.archived_at
 FROM public.units u
 JOIN public.floors f ON f.id=u.floor_id
 JOIN public.sections s ON s.id=f.section_id
 JOIN public.buildings b ON b.id=s.building_id
), deal_project AS (
 SELECT d.id, p.project_id, d.status, d.currency, d.responsible_user_id
 FROM public.deals d LEFT JOIN unit_project p ON p.id=d.unit_id
), cash_documents AS (
 SELECT 'PAYMENT' kind,p.id,p.cash_desk_id,p.deal_id,d.project_id,p.status,
  p.currency,p.operation_type,p.transfer_id,p.conversion_id
 FROM public.payments p LEFT JOIN deal_project d ON d.id=p.deal_id
 UNION ALL
 SELECT 'EXPENSE',e.id,e.cash_desk_id,e.deal_id,d.project_id,e.status,
  e.currency,e.operation_type,e.transfer_id,e.conversion_id
 FROM public.expenses e LEFT JOIN deal_project d ON d.id=e.deal_id
)
SELECT jsonb_build_object(
 'snapshot_at',now(),
 'users',(SELECT jsonb_agg(x) FROM (
  SELECT id,role,is_active,permissions,is_sales_rep FROM public.users ORDER BY id
 )x),
 'complexes',(SELECT jsonb_agg(x) FROM (
  SELECT id,code,name,archived_at FROM public.projects ORDER BY id
 )x),
 'units',(SELECT jsonb_agg(x) FROM (
  SELECT project_id,unit_kind,status,count(*) count FROM unit_project
  WHERE archived_at IS NULL GROUP BY project_id,unit_kind,status
  ORDER BY project_id,unit_kind,status
 )x),
 'deals',(SELECT jsonb_agg(x) FROM (
  SELECT project_id,status,currency,count(*) count FROM deal_project
  GROUP BY project_id,status,currency ORDER BY project_id,status,currency
 )x),
 'cash_desks',(SELECT jsonb_agg(x) FROM (
  SELECT id,code,name,is_active FROM public.dictionaries WHERE type='CASH_DESK'
  ORDER BY sort_order,id
 )x),
 'cash_access',(SELECT jsonb_agg(x) FROM (
  SELECT user_id,cash_desk_id,can_view,can_create_income,can_create_expense,
   can_edit,can_void,can_delete FROM public.user_cash_desk_access
  ORDER BY user_id,cash_desk_id
 )x),
 'cash_document_groups',(SELECT jsonb_agg(x) FROM (
  SELECT kind,cash_desk_id,project_id,status,currency,count(*) count,
   count(*) FILTER(WHERE transfer_id IS NOT NULL) transfer_legs,
   count(*) FILTER(WHERE conversion_id IS NOT NULL) conversion_legs
  FROM cash_documents GROUP BY kind,cash_desk_id,project_id,status,currency
  ORDER BY kind,cash_desk_id,project_id,status,currency
 )x),
 'cross_scope_cash',(SELECT jsonb_agg(x) FROM (
  SELECT kind,cash_desk_id,project_id,status,count(*) count
  FROM cash_documents WHERE
   (project_id=3 AND cash_desk_id='9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2'::uuid)
   OR (project_id=4 AND cash_desk_id IS NOT NULL
       AND cash_desk_id<>'9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2'::uuid)
  GROUP BY kind,cash_desk_id,project_id,status
 )x),
 'warehouses',(SELECT jsonb_agg(x) FROM (
  SELECT w.id,w.active,p.user_id responsible_user_id
  FROM public.construction_warehouses w
  LEFT JOIN public.construction_parties p ON p.id=w.responsible_id
  ORDER BY w.id
 )x),
 'stock_links',(SELECT jsonb_agg(x) FROM (
  SELECT warehouse_id,project_id,status,count(*) count
  FROM public.construction_documents GROUP BY warehouse_id,project_id,status
 )x),
 'construction_settings',(SELECT jsonb_agg(x) FROM (
  SELECT start_date,approver_user_id FROM public.construction_settings
 )x),
 'unlinked_deals',(SELECT count(*) FROM deal_project WHERE project_id IS NULL),
 'counts',jsonb_build_object(
  'users',(SELECT count(*) FROM public.users),
  'units',(SELECT count(*) FROM public.units),
  'deals',(SELECT count(*) FROM public.deals),
  'payments',(SELECT count(*) FROM public.payments),
  'expenses',(SELECT count(*) FROM public.expenses),
  'construction_documents',(SELECT count(*) FROM public.construction_documents)
 )
) AS source_inventory;
