-- Read-only preparation audit; never grants access or activates a project.
CREATE FUNCTION public.read_company_project_readiness(p_actor integer,p_project uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE project public.company_projects; result jsonb;
BEGIN
 -- Same fresh company-admin authorization used for project settings.
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 SELECT * INTO project FROM public.company_projects WHERE id=p_project;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 WITH complexes AS MATERIALIZED (
  SELECT c.id,c.code,c.archived_at FROM public.projects c JOIN public.company_project_complexes m ON m.complex_id=c.id WHERE m.company_project_id=p_project
 ), members AS MATERIALIZED (
  SELECT m.user_id,m.project_role,u.is_active=1 AS active,coalesce(u.permissions,'[]'::jsonb)?'company.project-only' AS project_only,coalesce(w.enabled,false) AS roster_enabled,coalesce(a.enabled,false) AS access_enabled,coalesce(a.sections,'{}'::text[]) AS sections,coalesce(a.write_sections,'{}'::text[]) AS write_sections
  FROM public.company_project_memberships m JOIN public.users u ON u.id=m.user_id LEFT JOIN public.company_workspace_users w ON w.user_id=m.user_id LEFT JOIN public.company_workspace_access a ON a.user_id=m.user_id AND a.company_project_id=m.company_project_id WHERE m.company_project_id=p_project
 ), own_deals AS MATERIALIZED (
  SELECT d.id,d.company_project_id,cp.company_project_id AS unit_project,cl.company_project_id AS lead_project
  FROM public.deals d LEFT JOIN public.units u ON u.id=d.unit_id LEFT JOIN public.floors f ON f.id=u.floor_id LEFT JOIN public.sections s ON s.id=f.section_id LEFT JOIN public.buildings b ON b.id=s.building_id LEFT JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id LEFT JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id
  WHERE d.company_project_id=p_project OR cp.company_project_id=p_project
 )
 SELECT jsonb_build_object(
  'project_id',project.id,'revision',project.revision,'checked_at',now(),
  'director_present',length(btrim(project.director_name))>0,'authority_present',length(btrim(project.director_authority))>0,
  'partner_count',(SELECT count(*) FROM public.company_project_partners WHERE company_project_id=p_project),
  'partner_total',(SELECT coalesce(sum(share_percent),0) FROM public.company_project_partners WHERE company_project_id=p_project),
  'complex_count',(SELECT count(*) FROM complexes),'archived_complex_count',(SELECT count(*) FROM complexes WHERE archived_at IS NOT NULL),
  'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY user_id),'[]'::jsonb) FROM members m),
  'cash_count',(SELECT count(*) FROM public.company_project_cash_desks m JOIN public.dictionaries d ON d.id=m.cash_desk_id WHERE m.company_project_id=p_project AND d.type='CASH_DESK' AND d.is_active IS DISTINCT FROM false),
  'warehouse_count',(SELECT count(*) FROM public.company_project_warehouses m JOIN public.construction_warehouses w ON w.id=m.warehouse_id WHERE m.company_project_id=p_project AND w.active),
  'deal_scope_issues',(SELECT count(*) FROM own_deals WHERE company_project_id IS DISTINCT FROM p_project OR unit_project IS DISTINCT FROM p_project OR lead_project IS DISTINCT FROM p_project),
  'payment_scope_issues',(SELECT count(*) FROM public.payments x JOIN own_deals d ON d.id=x.deal_id LEFT JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=x.cash_desk_id WHERE cp.company_project_id IS DISTINCT FROM p_project),
  'expense_scope_issues',(SELECT count(*) FROM public.expenses x JOIN own_deals d ON d.id=x.deal_id LEFT JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=x.cash_desk_id WHERE cp.company_project_id IS DISTINCT FROM p_project),
  'template_gaps',(SELECT count(*) FROM complexes c CROSS JOIN (VALUES('CONTRACT'),('SCHEDULE')) k(kind) CROSS JOIN (VALUES('RU'),('TJ')) l(language) WHERE NOT EXISTS(SELECT 1 FROM public.crm_document_templates t WHERE t.active AND t.kind=k.kind AND t.language=l.language AND t.scope IN ('*',c.id::text))),
  'private_bucket',(SELECT jsonb_build_object('exists',true,'private',NOT b.public) FROM storage.buckets b WHERE b.id='company-project-private')
 ) INTO result;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_readiness(integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_readiness(integer,uuid) TO service_role;
