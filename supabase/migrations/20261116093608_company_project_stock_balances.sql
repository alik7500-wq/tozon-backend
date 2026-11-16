-- Read-only project stock balances. Existing ledger remains authoritative.
CREATE FUNCTION public.read_company_project_stock(p_actor integer,p_project uuid,p_warehouse uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE context jsonb; permissions text[]; warehouses jsonb; selected uuid; records jsonb; totals jsonb;
BEGIN
 context:=public.read_company_project_workspace(p_actor,NULL,'projects');
 SELECT ARRAY(SELECT jsonb_array_elements_text(p->'sections')) INTO permissions
 FROM jsonb_array_elements(context->'projects') p WHERE p->>'id'=p_project::text;
 IF permissions IS NULL OR NOT('construction.stock'=ANY(permissions)) THEN
  RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'active',w.active) ORDER BY w.active DESC,w.name,w.id),'[]'::jsonb)
 INTO warehouses FROM public.construction_warehouses w JOIN public.company_project_warehouses cp ON cp.warehouse_id=w.id
 WHERE cp.company_project_id=p_project;
 selected:=coalesce(p_warehouse,(warehouses->0->>'id')::uuid);
 IF selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company_project_warehouses WHERE warehouse_id=selected AND company_project_id=p_project) THEN
  RAISE EXCEPTION 'WORKSPACE_RECORD_NOT_FOUND' USING ERRCODE='P0002';
 END IF;
 -- Refuse a partial balance if historical links point outside this project.
 IF EXISTS(
  SELECT 1 FROM public.construction_stock_entries e LEFT JOIN public.construction_documents d ON d.id=e.document_id
  WHERE e.warehouse_id=selected AND (
   d.id IS NULL OR d.status IS DISTINCT FROM 'POSTED' OR e.currency IS DISTINCT FROM d.currency
   OR NOT EXISTS(SELECT 1 FROM public.company_project_warehouses cp WHERE cp.warehouse_id=d.warehouse_id AND cp.company_project_id=p_project)
   OR (d.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company_project_complexes cp WHERE cp.complex_id=d.project_id AND cp.company_project_id=p_project))
   OR (d.kind='TRANSFER' AND NOT EXISTS(SELECT 1 FROM public.company_project_warehouses cp WHERE cp.warehouse_id=d.destination_id AND cp.company_project_id=p_project))
   OR (e.warehouse_id IS DISTINCT FROM d.warehouse_id AND (d.kind IS DISTINCT FROM 'TRANSFER' OR e.warehouse_id IS DISTINCT FROM d.destination_id))
  )
 ) THEN RAISE EXCEPTION 'WORKSPACE_STOCK_SCOPE_CONFLICT' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM (SELECT material_id,currency FROM public.construction_stock_entries WHERE warehouse_id=selected GROUP BY material_id,currency HAVING sum(quantity)<>0 OR sum(value)<>0) x)>5000 THEN
  RAISE EXCEPTION 'WORKSPACE_STOCK_TOO_LARGE' USING ERRCODE='54000';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('material_id',x.material_id,'name',m.name,'unit',m.unit,'currency',x.currency,'quantity',x.quantity::text,'value',x.value::text) ORDER BY m.name,x.material_id,x.currency),'[]'::jsonb)
 INTO records FROM (SELECT material_id,currency,sum(quantity) AS quantity,sum(value) AS value FROM public.construction_stock_entries WHERE warehouse_id=selected GROUP BY material_id,currency HAVING sum(quantity)<>0 OR sum(value)<>0) x
 JOIN public.construction_materials m ON m.id=x.material_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('currency',x.currency,'value',x.value::text) ORDER BY x.currency),'[]'::jsonb)
 INTO totals FROM (SELECT currency,sum(value) AS value FROM public.construction_stock_entries WHERE warehouse_id=selected GROUP BY currency) x;
 RETURN jsonb_build_object('project_id',p_project,'checked_at',now(),'warehouses',warehouses,'selected_warehouse_id',selected,'records',records,'totals',totals);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_stock(integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_stock(integer,uuid,uuid) TO service_role;
