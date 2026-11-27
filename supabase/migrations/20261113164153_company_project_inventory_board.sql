-- Complete inventory for one authorized complex. No customer/deal data or writes.
CREATE FUNCTION public.read_company_project_inventory(p_actor integer,p_project uuid,p_complex integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE context jsonb; permissions text[]; complexes jsonb; selected integer; rows jsonb;
BEGIN
 context:=public.read_company_project_workspace(p_actor,NULL,'projects');
 SELECT ARRAY(SELECT jsonb_array_elements_text(p->'sections')) INTO permissions
 FROM jsonb_array_elements(context->'projects') p WHERE p->>'id'=p_project::text;
 IF permissions IS NULL OR NOT ('inventory.view'=ANY(permissions)) THEN
  RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'currency',p.currency) ORDER BY p.name,p.id),'[]'::jsonb)
 INTO complexes FROM public.projects p JOIN public.company_project_complexes cp ON cp.complex_id=p.id
 WHERE cp.company_project_id=p_project AND p.archived_at IS NULL;
 selected:=coalesce(p_complex,(complexes->0->>'id')::integer);
 IF selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(complexes) c WHERE (c->>'id')::integer=selected) THEN
  RAISE EXCEPTION 'WORKSPACE_RECORD_NOT_FOUND' USING ERRCODE='P0002';
 END IF;
 WITH inventory AS (
  SELECT u.id,u.unit_number,u.rooms,u.unit_kind,u.status,u.area_m2_x100,u.price_per_m2_minor,u.manual_total_price_minor,u.position_on_floor,
   b.id AS building_id,b.name AS building_name,b.sort_order AS building_order,
   s.id AS section_id,s.name AS section_name,s.sort_order AS section_order,
   f.id AS floor_id,f.floor_number
  FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id
  JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id
  JOIN public.company_project_complexes cp ON cp.complex_id=p.id AND cp.company_project_id=p_project
  WHERE p.id=selected AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL
   AND b.archived_at IS NULL AND p.archived_at IS NULL
  ORDER BY b.sort_order NULLS LAST,b.id,s.sort_order NULLS LAST,s.id,f.floor_number DESC,f.id,u.position_on_floor NULLS LAST,u.id
  LIMIT 5001
 ) SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.building_order NULLS LAST,i.building_id,i.section_order NULLS LAST,i.section_id,i.floor_number DESC,i.floor_id,i.position_on_floor NULLS LAST,i.id),'[]'::jsonb)
 INTO rows FROM inventory i;
 -- Never present an incomplete chessboard as a complete inventory.
 IF jsonb_array_length(rows)>5000 THEN RAISE EXCEPTION 'WORKSPACE_INVENTORY_TOO_LARGE' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'complexes',complexes,'selected_complex_id',selected,'records',rows,'checked_at',now());
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_inventory(integer,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_inventory(integer,uuid,integer) TO service_role;
