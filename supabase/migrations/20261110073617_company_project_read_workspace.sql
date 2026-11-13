-- Read-only pilot, not production activation. No existing rows are reassigned.
CREATE TABLE public.company_workspace_users (
  user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.company_workspace_access (
  user_id integer NOT NULL REFERENCES public.company_workspace_users(user_id) ON DELETE RESTRICT,
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
  sections text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,company_project_id),
  FOREIGN KEY(company_project_id,user_id) REFERENCES public.company_project_memberships(company_project_id,user_id) ON DELETE RESTRICT,
  CHECK(sections <@ ARRAY['inventory.view','leads.view','deals.view','finance.payments','finance.expenses','construction.stock']::text[])
);
CREATE INDEX company_workspace_access_project ON public.company_workspace_access(company_project_id);
CREATE TABLE public.company_project_leads (
  lead_id integer PRIMARY KEY REFERENCES public.leads(id) ON DELETE RESTRICT,
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT
);
CREATE INDEX company_project_leads_parent ON public.company_project_leads(company_project_id);
CREATE TABLE public.company_project_cash_desks (
  cash_desk_id uuid PRIMARY KEY REFERENCES public.dictionaries(id) ON DELETE RESTRICT,
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT
);
CREATE INDEX company_project_cash_desks_parent ON public.company_project_cash_desks(company_project_id);
CREATE TABLE public.company_project_warehouses (
  warehouse_id uuid PRIMARY KEY REFERENCES public.construction_warehouses(id) ON DELETE RESTRICT,
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT
);
CREATE INDEX company_project_warehouses_parent ON public.company_project_warehouses(company_project_id);
DO $block$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['company_workspace_users','company_workspace_access','company_project_leads','company_project_cash_desks','company_project_warehouses'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
  END LOOP;
END $block$;

-- A private trigger protects the project-only marker against legacy user editing.
-- Definer privilege is limited to checking the private pilot roster; no data is returned.
CREATE SCHEMA IF NOT EXISTS tozon_internal;
REVOKE ALL ON SCHEMA tozon_internal FROM PUBLIC,anon,authenticated;
CREATE FUNCTION tozon_internal.protect_workspace_user_marker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF TG_TABLE_NAME='company_workspace_users' THEN
    IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.user_id AND coalesce(permissions,'[]'::jsonb) ? 'company.project-only') THEN
      RAISE EXCEPTION 'PROJECT_ONLY_MARKER_REQUIRED' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM public.company_workspace_users WHERE user_id=NEW.id) AND
       NOT (coalesce(NEW.permissions,'[]'::jsonb) ? 'company.project-only') THEN
      RAISE EXCEPTION 'PROJECT_ONLY_MARKER_CANNOT_BE_REMOVED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.protect_workspace_user_marker() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER company_workspace_marker_on_register BEFORE INSERT OR UPDATE ON public.company_workspace_users FOR EACH ROW EXECUTE FUNCTION tozon_internal.protect_workspace_user_marker();
CREATE TRIGGER company_workspace_marker_on_user_update BEFORE UPDATE OF permissions ON public.users FOR EACH ROW EXECUTE FUNCTION tozon_internal.protect_workspace_user_marker();

CREATE FUNCTION public.read_company_project_workspace(p_actor integer,p_project uuid,p_resource text,p_record text DEFAULT NULL,p_after text DEFAULT '',p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_section text; v_sql text; v_common text; v_rows jsonb; v_allowed boolean; v_sections text[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.company_workspace_users w ON w.user_id=u.id WHERE u.id=p_actor AND u.is_active=1 AND w.enabled AND coalesce(u.permissions,'[]'::jsonb) ? 'company.project-only') THEN
    RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR length(coalesce(p_after,''))>40 OR length(coalesce(p_record,''))>40 THEN
    RAISE EXCEPTION 'INVALID_WORKSPACE_PAGE' USING ERRCODE='22023';
  END IF;
  IF p_resource='projects' THEN
    IF p_project IS NOT NULL OR p_record IS NOT NULL THEN RAISE EXCEPTION 'INVALID_WORKSPACE_CONTEXT' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('projects',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'location',p.location,'sections',a.sections) ORDER BY p.name)
      FROM public.company_workspace_access a JOIN public.company_projects p ON p.id=a.company_project_id
      JOIN public.company_project_memberships m ON m.company_project_id=p.id AND m.user_id=p_actor
      WHERE a.user_id=p_actor AND a.enabled
    ),'[]'::jsonb),'mode','PILOT_READ');
  END IF;
  v_section:=CASE p_resource WHEN 'complexes' THEN 'inventory.view' WHEN 'units' THEN 'inventory.view'
    WHEN 'leads' THEN 'leads.view' WHEN 'deals' THEN 'deals.view'
    WHEN 'payments' THEN 'finance.payments' WHEN 'schedules' THEN 'finance.payments'
    WHEN 'expenses' THEN 'finance.expenses' WHEN 'warehouses' THEN 'construction.stock' ELSE NULL END;
  IF v_section IS NULL THEN RAISE EXCEPTION 'WORKSPACE_RESOURCE_DISABLED' USING ERRCODE='42501'; END IF;
  SELECT a.sections INTO v_sections FROM public.company_workspace_access a
    JOIN public.company_project_memberships m ON m.company_project_id=a.company_project_id AND m.user_id=a.user_id
    WHERE a.user_id=p_actor AND a.company_project_id=p_project AND a.enabled;
  IF NOT FOUND OR NOT (v_section=ANY(v_sections)) THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
  v_common:=$query$
    WITH own_units AS (
      SELECT u.id,u.unit_number,u.area_m2_x100,u.price_per_m2_minor,u.status,u.unit_kind,p.id AS complex_id,p.name AS complex_name
      FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id
      JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id
      JOIN public.company_project_complexes cp ON cp.complex_id=p.id
      WHERE cp.company_project_id=$1 AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND p.archived_at IS NULL
    ), own_deals AS (
      SELECT d.id,d.contract_number,d.status,d.currency,d.final_price_minor,d.down_payment_minor,d.deal_date,d.lead_id,d.unit_id
      FROM public.deals d JOIN own_units u ON u.id=d.unit_id
      JOIN public.company_project_leads l ON l.lead_id=d.lead_id AND l.company_project_id=$1
    ), records AS (
  $query$;
  v_sql:=CASE p_resource
    WHEN 'complexes' THEN 'SELECT p.id::text AS id,jsonb_build_object(''id'',p.id,''name'',p.name,''code'',p.code,''address'',p.address) AS item FROM public.projects p JOIN public.company_project_complexes cp ON cp.complex_id=p.id WHERE cp.company_project_id=$1 AND p.archived_at IS NULL'
    WHEN 'units' THEN 'SELECT u.id::text AS id,to_jsonb(u) AS item FROM own_units u'
    WHEN 'leads' THEN 'SELECT l.id::text AS id,jsonb_build_object(''id'',l.id,''full_name'',l.full_name,''phone'',l.phone,''status'',l.status) AS item FROM public.leads l JOIN public.company_project_leads cp ON cp.lead_id=l.id WHERE cp.company_project_id=$1 AND l.archived_at IS NULL'
    WHEN 'deals' THEN 'SELECT d.id::text AS id,to_jsonb(d) AS item FROM own_deals d'
    WHEN 'payments' THEN 'SELECT p.id::text AS id,jsonb_build_object(''id'',p.id,''deal_id'',p.deal_id,''amount_minor'',p.amount_minor,''currency'',p.currency,''payment_date'',p.payment_date,''status'',p.status) AS item FROM public.payments p JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=p.cash_desk_id WHERE cp.company_project_id=$1 AND (p.deal_id IS NULL OR EXISTS(SELECT 1 FROM own_deals d WHERE d.id=p.deal_id))'
    WHEN 'schedules' THEN 'SELECT s.id::text AS id,jsonb_build_object(''id'',s.id,''deal_id'',s.deal_id,''due_date'',s.due_date,''amount_minor'',s.amount_minor,''paid_amount_minor'',s.paid_amount_minor,''currency'',d.currency,''status'',s.status) AS item FROM public.deal_payment_schedules s JOIN own_deals d ON d.id=s.deal_id'
    WHEN 'expenses' THEN 'SELECT e.id::text AS id,jsonb_build_object(''id'',e.id,''deal_id'',e.deal_id,''amount_minor'',e.amount_minor,''currency'',e.currency,''expense_date'',e.expense_date,''category'',e.category,''status'',e.status) AS item FROM public.expenses e JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=e.cash_desk_id WHERE cp.company_project_id=$1 AND (e.deal_id IS NULL OR EXISTS(SELECT 1 FROM own_deals d WHERE d.id=e.deal_id))'
    WHEN 'warehouses' THEN 'SELECT w.id::text AS id,jsonb_build_object(''id'',w.id,''name'',w.name,''active'',w.active) AS item FROM public.construction_warehouses w JOIN public.company_project_warehouses cp ON cp.warehouse_id=w.id WHERE cp.company_project_id=$1'
  END;
  EXECUTE v_common || v_sql || $query$
    ), page AS (SELECT id,item FROM records WHERE ($2::text IS NULL OR id=$2) AND id>coalesce($3,'') ORDER BY id LIMIT $4)
    SELECT coalesce(jsonb_agg(item ORDER BY id),'[]'::jsonb) FROM page
  $query$ INTO v_rows USING p_project,p_record,p_after,p_limit+1;
  IF p_record IS NOT NULL AND jsonb_array_length(v_rows)=0 THEN RAISE EXCEPTION 'WORKSPACE_RECORD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('records',CASE WHEN jsonb_array_length(v_rows)>p_limit THEN v_rows-p_limit ELSE v_rows END,
    'has_more',jsonb_array_length(v_rows)>p_limit,'project_id',p_project,'resource',p_resource,'mode','PILOT_READ');
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_workspace(integer,uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_workspace(integer,uuid,text,text,text,integer) TO service_role;
-- Pilot users, grants and record mappings are intentionally empty after migration.
