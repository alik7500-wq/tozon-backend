-- Scoped overview only. No business rows, grants or memberships are changed.
CREATE FUNCTION public.read_company_project_overview(p_actor integer,p_project uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE context jsonb; permissions text[]; result jsonb;
BEGIN
 context:=public.read_company_project_workspace(p_actor,NULL,'projects');
 SELECT ARRAY(SELECT jsonb_array_elements_text(p->'sections')) INTO permissions
 FROM jsonb_array_elements(context->'projects') p WHERE p->>'id'=p_project::text;
 IF permissions IS NULL THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 WITH own_units AS MATERIALIZED (
  SELECT u.id,u.unit_number,u.unit_kind,u.status,p.name AS complex_name
  FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id
  JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id
  JOIN public.company_project_complexes cp ON cp.complex_id=p.id
  WHERE cp.company_project_id=p_project AND u.archived_at IS NULL AND f.archived_at IS NULL
   AND s.archived_at IS NULL AND b.archived_at IS NULL AND p.archived_at IS NULL
 ), own_deals AS MATERIALIZED (
  SELECT d.id,d.contract_number,d.status,d.currency,d.lead_id,d.unit_id
  FROM public.deals d JOIN own_units u ON u.id=d.unit_id
  JOIN public.company_project_leads cp ON cp.lead_id=d.lead_id AND cp.company_project_id=p_project
  WHERE d.company_project_id=p_project
 ), upcoming AS (
  SELECT s.id,s.due_date,d.id AS deal_id,d.contract_number,u.unit_number,u.complex_name,d.currency,
   greatest(0,s.amount_minor-coalesce(s.paid_amount_minor,0)) AS remaining_minor,
   CASE WHEN 'leads.view'=ANY(permissions) THEN l.full_name ELSE NULL END AS client_name
  FROM public.deal_payment_schedules s JOIN own_deals d ON d.id=s.deal_id JOIN own_units u ON u.id=d.unit_id
  JOIN public.leads l ON l.id=d.lead_id
  WHERE 'finance.payments'=ANY(permissions) AND 'deals.view'=ANY(permissions) AND d.status='SIGNED'
   AND s.status NOT IN ('CANCELLED','VOIDED','PAID') AND s.amount_minor>coalesce(s.paid_amount_minor,0)
   AND s.due_date::date>=(now() AT TIME ZONE 'Asia/Dushanbe')::date
  ORDER BY s.due_date::date,s.id LIMIT 5
 )
 SELECT jsonb_build_object('project_id',p_project,'checked_at',now(),
  'inventory',CASE WHEN 'inventory.view'=ANY(permissions) THEN (SELECT jsonb_build_object(
   'apartments',count(*) FILTER(WHERE unit_kind='APARTMENT'),
   'available',count(*) FILTER(WHERE unit_kind='APARTMENT' AND status='AVAILABLE'),
   'reserved',count(*) FILTER(WHERE unit_kind='APARTMENT' AND status='RESERVED'),
   'sold',count(*) FILTER(WHERE unit_kind='APARTMENT' AND status='SOLD')) FROM own_units) ELSE NULL END,
  'active_leads',CASE WHEN 'leads.view'=ANY(permissions) THEN (SELECT count(*) FROM public.leads l
   JOIN public.company_project_leads cp ON cp.lead_id=l.id WHERE cp.company_project_id=p_project AND l.archived_at IS NULL
   AND l.status NOT IN ('WON','LOST','REJECTED','CLOSED') AND NOT EXISTS(SELECT 1 FROM own_deals d WHERE d.lead_id=l.id AND d.status='SIGNED')) ELSE NULL END,
  'signed_contracts',CASE WHEN 'deals.view'=ANY(permissions) THEN (SELECT count(*) FROM own_deals WHERE status='SIGNED') ELSE NULL END,
  'upcoming_payments',CASE WHEN 'finance.payments'=ANY(permissions) AND 'deals.view'=ANY(permissions)
   THEN (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date::date,x.id),'[]'::jsonb) FROM upcoming x) ELSE NULL END
 ) INTO result;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_overview(integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_overview(integer,uuid) TO service_role;
