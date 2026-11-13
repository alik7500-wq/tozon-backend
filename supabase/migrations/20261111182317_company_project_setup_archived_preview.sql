-- Archived hierarchy requires a separate review; it must not break the entire setup panel.
CREATE OR REPLACE FUNCTION public.read_company_project_unbound_deals(p_actor integer,p_project uuid,p_after integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE ids integer[];items jsonb;
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.company_projects WHERE id=p_project) THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT d.id FROM public.deals d JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id JOIN public.projects c ON c.id=b.project_id WHERE u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL AND cp.company_project_id=p_project AND d.company_project_id IS NULL AND d.id>coalesce(p_after,0) ORDER BY d.id LIMIT 51) q;
 SELECT coalesce(jsonb_agg(tozon_internal.project_demo_binding(p_project,id) ORDER BY id),'[]'::jsonb) INTO items FROM unnest(ids[1:50]) id;
 RETURN jsonb_build_object('records',items,'has_more',coalesce(cardinality(ids)>50,false));
END $fn$;
