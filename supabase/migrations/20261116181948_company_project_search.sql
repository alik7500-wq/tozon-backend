-- Read-only search and fresh record previews, restricted to granted project sections.
CREATE FUNCTION public.search_company_project_workspace(p_actor integer,p_project uuid,p_query text DEFAULT NULL,p_resource text DEFAULT NULL,p_record integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE context jsonb; permissions text[]; kind text; permission text; statement text; rows jsonb; groups jsonb:='[]'::jsonb; needle text; phone text; detail boolean;
BEGIN
 detail:=p_resource IS NOT NULL OR p_record IS NOT NULL;
 IF detail THEN
  IF p_resource IS NULL OR p_resource NOT IN ('leads','deals','units') OR p_record IS NULL OR p_record<1 OR p_query IS NOT NULL THEN
   RAISE EXCEPTION 'WORKSPACE_INVALID_SEARCH' USING ERRCODE='22023';
  END IF;
 ELSE
  needle:=lower(btrim(p_query));
  IF needle IS NULL OR (length(needle)<2 AND needle!~'^[0-9]$') OR length(needle)>100 OR needle~'[[:cntrl:]]' THEN RAISE EXCEPTION 'WORKSPACE_INVALID_SEARCH' USING ERRCODE='22023';END IF;
  IF needle~'^[+0-9() .-]+$' THEN phone:=regexp_replace(needle,'[^0-9]','','g');IF length(phone)<3 THEN phone:=NULL;END IF;END IF;
 END IF;
 context:=public.read_company_project_workspace(p_actor,NULL,'projects');
 SELECT ARRAY(SELECT jsonb_array_elements_text(p->'sections')) INTO permissions
 FROM jsonb_array_elements(context->'projects') p WHERE p->>'id'=p_project::text;
 IF permissions IS NULL OR NOT(permissions&&ARRAY['inventory.view','leads.view','deals.view']::text[]) THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 FOREACH kind IN ARRAY ARRAY['leads','deals','units'] LOOP
  IF detail AND kind<>p_resource THEN CONTINUE;END IF;
  permission:=CASE kind WHEN 'leads' THEN 'leads.view' WHEN 'deals' THEN 'deals.view' ELSE 'inventory.view' END;
  IF NOT(permission=ANY(permissions)) THEN
   IF detail THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
   CONTINUE;
  END IF;
  statement:=$sql$
   WITH own_units AS (
    SELECT u.id,u.unit_number,u.status,u.area_m2_x100,p.name AS complex_name
    FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id
    JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id
    JOIN public.company_project_complexes cp ON cp.complex_id=p.id AND cp.company_project_id=$1
    WHERE u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND p.archived_at IS NULL
   ), candidates AS (
  $sql$ || CASE kind
   WHEN 'leads' THEN $sql$
    SELECT l.id,l.full_name AS title,l.phone AS subtitle,l.status,regexp_replace(coalesce(l.phone,''),'[^0-9]','','g') AS phone
    FROM public.leads l JOIN public.company_project_leads cp ON cp.lead_id=l.id AND cp.company_project_id=$1 WHERE l.archived_at IS NULL
   $sql$
   WHEN 'deals' THEN $sql$
    SELECT d.id,coalesce(nullif(d.contract_number,''),'ID '||d.id::text) AS title,d.deal_date::text AS subtitle,d.status,NULL::text AS phone
    FROM public.deals d JOIN own_units u ON u.id=d.unit_id
    JOIN public.company_project_leads cp ON cp.lead_id=d.lead_id AND cp.company_project_id=$1
    WHERE d.company_project_id IS NULL OR d.company_project_id=$1
   $sql$
   ELSE $sql$SELECT u.id,u.unit_number AS title,u.complex_name AS subtitle,u.status,NULL::text AS phone FROM own_units u$sql$
  END || $sql$
   ), matches AS (SELECT id,title,subtitle,status FROM candidates WHERE
    ($2::integer IS NOT NULL AND id=$2) OR ($2 IS NULL AND (strpos(lower(coalesce(title,'')),$3)>0 OR strpos(lower(coalesce(subtitle,'')),$3)>0 OR ($4::text IS NOT NULL AND strpos(phone,$4)>0)))
    ORDER BY title,id LIMIT 11)
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'subtitle',subtitle,'status',status) ORDER BY title,id),'[]'::jsonb) FROM matches
  $sql$;
  EXECUTE statement INTO rows USING p_project,p_record,needle,phone;
  IF detail THEN
   IF jsonb_array_length(rows)=0 THEN RAISE EXCEPTION 'WORKSPACE_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
   RETURN jsonb_build_object('project_id',p_project,'resource',kind,'record',rows->0,'checked_at',now());
  END IF;
  groups:=groups||jsonb_build_array(jsonb_build_object('resource',kind,'records',CASE WHEN jsonb_array_length(rows)>10 THEN rows-10 ELSE rows END,'has_more',jsonb_array_length(rows)>10));
 END LOOP;
 RETURN jsonb_build_object('project_id',p_project,'query',btrim(p_query),'groups',groups,'checked_at',now());
END $fn$;
REVOKE ALL ON FUNCTION public.search_company_project_workspace(integer,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_project_workspace(integer,uuid,text,text,integer) TO service_role;
