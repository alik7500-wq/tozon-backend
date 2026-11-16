-- Cash-book projection only. Never reinterpret historical transfers or FX snapshots.
CREATE FUNCTION public.read_company_project_cash_book(p_actor integer,p_project uuid,p_cash_desk uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE context jsonb; permissions text[]; desks jsonb; selected uuid; records jsonb; totals jsonb; review boolean;
BEGIN
 context:=public.read_company_project_workspace(p_actor,NULL,'projects');
 SELECT ARRAY(SELECT jsonb_array_elements_text(p->'sections')) INTO permissions
 FROM jsonb_array_elements(context->'projects') p WHERE p->>'id'=p_project::text;
 IF permissions IS NULL OR NOT(ARRAY['finance.payments','finance.expenses']::text[] <@ permissions) THEN
  RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'active',d.is_active) ORDER BY d.is_active DESC,d.name,d.id),'[]'::jsonb)
 INTO desks FROM public.dictionaries d JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=d.id
 WHERE cp.company_project_id=p_project AND d.type='CASH_DESK';
 selected:=coalesce(p_cash_desk,(desks->0->>'id')::uuid);
 IF selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(desks) d WHERE d->>'id'=selected::text) THEN
  RAISE EXCEPTION 'WORKSPACE_RECORD_NOT_FOUND' USING ERRCODE='P0002';
 END IF;
 -- Historical archived units remain valid; contradictory project links do not.
 IF EXISTS(
  SELECT 1 FROM (SELECT deal_id FROM public.payments WHERE cash_desk_id=selected UNION ALL SELECT deal_id FROM public.expenses WHERE cash_desk_id=selected) cash
  WHERE cash.deal_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.deals d JOIN public.units u ON u.id=d.unit_id
   JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id
   JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id AND cp.company_project_id=p_project
   JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id AND cl.company_project_id=p_project
   WHERE d.id=cash.deal_id AND (d.company_project_id IS NULL OR d.company_project_id=p_project)
  )
 ) THEN RAISE EXCEPTION 'WORKSPACE_CASH_SCOPE_CONFLICT' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM (SELECT id FROM public.payments WHERE cash_desk_id=selected UNION ALL SELECT id FROM public.expenses WHERE cash_desk_id=selected) x)>5000 THEN
  RAISE EXCEPTION 'WORKSPACE_CASH_TOO_LARGE' USING ERRCODE='54000';
 END IF;
 WITH ledger AS (
  SELECT id,'INCOME'::text AS kind,payment_date::text AS date,amount_minor,currency,status,voided_at,settlement_method,method,operation_type,transfer_id,conversion_id FROM public.payments WHERE cash_desk_id=selected
  UNION ALL
  SELECT id,'EXPENSE',expense_date::text,amount_minor,currency,status,voided_at,settlement_method,method,operation_type,transfer_id,conversion_id FROM public.expenses WHERE cash_desk_id=selected
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'date',date,'amount',round(amount_minor::numeric/100,2)::text,'currency',currency,'status',CASE WHEN voided_at IS NOT NULL THEN 'VOIDED' ELSE status END,
  'active',status IN ('ACTIVE','POSTED') AND voided_at IS NULL,'settlement_method',settlement_method,'operation_type',operation_type,
  'special',transfer_id IS NOT NULL OR conversion_id IS NOT NULL) ORDER BY date DESC NULLS LAST,id DESC,kind),'[]'::jsonb),
  coalesce(bool_or((status IS NULL OR status NOT IN ('ACTIVE','POSTED','VOIDED','CANCELLED','REVERSED')) OR
   (status IN ('ACTIVE','POSTED') AND voided_at IS NULL AND
    (settlement_method IS DISTINCT FROM 'CASH' OR (method IS NOT NULL AND method NOT IN ('CASH')) OR operation_type IS DISTINCT FROM 'STANDARD' OR transfer_id IS NOT NULL OR conversion_id IS NOT NULL OR amount_minor IS NULL OR amount_minor<0 OR currency IS NULL OR currency NOT IN ('USD','TJS','RUB')))),false)
 INTO records,review FROM ledger;
 -- Reclassified barter documents cannot be represented as physical cash.
 review:=review OR EXISTS(SELECT 1 FROM public.barter_realization_results r WHERE r.status='ACTIVE' AND
  (EXISTS(SELECT 1 FROM public.payments p WHERE p.id=r.reclassified_payment_id AND p.cash_desk_id=selected)
   OR EXISTS(SELECT 1 FROM public.expenses e WHERE e.id=r.reclassified_expense_id AND e.cash_desk_id=selected)));
 IF review THEN totals:=NULL;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('currency',currency,'income',income::text,'expense',expense::text,'balance',(income-expense)::text) ORDER BY currency),'[]'::jsonb) INTO totals
  FROM (SELECT currency,coalesce(sum(amount::numeric) FILTER(WHERE kind='INCOME'),0)::numeric(30,2) AS income,
   coalesce(sum(amount::numeric) FILTER(WHERE kind='EXPENSE'),0)::numeric(30,2) AS expense
   FROM jsonb_to_recordset(records) AS r(kind text,currency text,amount text,active boolean) WHERE active GROUP BY currency) x;
 END IF;
 RETURN jsonb_build_object('project_id',p_project,'checked_at',now(),'cash_desks',desks,'selected_cash_desk_id',selected,'records',records,'totals',totals,'requires_review',review);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_cash_book(integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_cash_book(integer,uuid,uuid) TO service_role;
