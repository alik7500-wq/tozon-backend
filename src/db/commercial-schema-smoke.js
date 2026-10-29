// Synthetic scenario only. Always roll back; never run against production.
export const commercialSchemaSmokeSql = String.raw`
BEGIN;
SET LOCAL ROLE service_role;
DO $smoke$
DECLARE u int; p int; b int; s int; f int; a int; l int; d int; sch int; desk uuid;
 payment jsonb; expense jsonb; repeated jsonb; assigned jsonb; result jsonb; pid int; pko bigint; failed boolean := false;
BEGIN
 INSERT INTO public.users(name,email,password_hash,role,is_sales_rep,created_at,updated_at) VALUES('Synthetic Admin','schema-smoke@example.invalid','not-a-login','ADMIN',true,now()::text,now()::text) RETURNING id INTO u;
 INSERT INTO public.projects(name,code,developer_name,address,created_at,updated_at) VALUES('Synthetic Project','SCHEMA_SMOKE','Example','Example',now()::text,now()::text) RETURNING id INTO p;
 INSERT INTO public.buildings(project_id,name,code,created_at,updated_at) VALUES(p,'A','A',now()::text,now()::text) RETURNING id INTO b;
 INSERT INTO public.sections(building_id,name,code,created_at,updated_at) VALUES(b,'A','A',now()::text,now()::text) RETURNING id INTO s;
 INSERT INTO public.floors(section_id,floor_number,name,created_at,updated_at) VALUES(s,1,'1',now()::text,now()::text) RETURNING id INTO f;
 INSERT INTO public.units(floor_id,unit_number,rooms,area_m2_x100,price_per_m2_minor,created_at,updated_at) VALUES(f,'1',2,7000,10000,now()::text,now()::text) RETURNING id INTO a;
 INSERT INTO public.leads(full_name,phone,created_at,updated_at) VALUES('Synthetic Buyer','TEST',now()::text,now()::text) RETURNING id INTO l;
 assigned:=public.fn_assign_lead_atomic(l::bigint,u::bigint,u::bigint,'Synthetic assignment',25,true);
 IF assigned->>'success'<>'true' THEN RAISE EXCEPTION 'LEAD_ASSIGNMENT_FAILED'; END IF;
 INSERT INTO public.deals(lead_id,unit_id,responsible_user_id,status,base_price_minor,final_price_minor,deal_date,created_at,updated_at) VALUES(l,a,u,'SIGNED',700000,700000,current_date::text,now()::text,now()::text) RETURNING id INTO d;
 BEGIN
  INSERT INTO public.deals(lead_id,unit_id,responsible_user_id,status,base_price_minor,final_price_minor,deal_date,created_at,updated_at) VALUES(l,a,u,'SIGNED',700000,700000,current_date::text,now()::text,now()::text);
 EXCEPTION WHEN unique_violation THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'DOUBLE_SALE_NOT_BLOCKED'; END IF;
 INSERT INTO public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,created_at,updated_at) VALUES(d,1,current_date::text,700000,now()::text,now()::text) RETURNING id INTO sch;
 INSERT INTO public.dictionaries(type,name,code) VALUES('CASH_DESK','Synthetic cash desk','SCHEMA_SMOKE') RETURNING id INTO desk;
 INSERT INTO public.user_cash_desk_access(user_id,cash_desk_id,can_create_income,can_create_expense,can_edit,can_void) VALUES(u,desk,true,true,true,true);
 payment:=public.create_income_payment_atomic(jsonb_build_object('deal_id',d,'schedule_id',sch,'amount_minor',10000,'currency','USD','cash_desk_id',desk,'settlement_method','CASH','created_by_user_id',u,'payment_date',current_date));
 IF payment->>'success'<>'true' THEN RAISE EXCEPTION 'PAYMENT_FAILED'; END IF;
 pid:=(payment->'payment'->>'id')::int;
 SELECT customer_pko_number INTO pko FROM public.payments WHERE id=pid;
 IF pko<>1 THEN RAISE EXCEPTION 'FRESH_PKO_NUMBER_FAILED'; END IF;
 IF (SELECT paid_amount_minor FROM public.deal_payment_schedules WHERE id=sch)<>10000 THEN RAISE EXCEPTION 'SCHEDULE_TOTAL_FAILED'; END IF;
 expense:=public.create_atomic_expense(desk,1000::bigint,'USD'::varchar,current_date,'Synthetic'::varchar,'Example'::varchar,'Synthetic expense',u,'CASH'::varchar,NULL,NULL,NULL,'schema-smoke-expense'::varchar);
 repeated:=public.create_atomic_expense(desk,1000::bigint,'USD'::varchar,current_date,'Synthetic'::varchar,'Example'::varchar,'Synthetic expense',u,'CASH'::varchar,NULL,NULL,NULL,'schema-smoke-expense'::varchar);
 IF repeated->>'idempotent'<>'true' OR expense->>'expense_id'<>repeated->>'expense_id' THEN RAISE EXCEPTION 'EXPENSE_IDEMPOTENCY_FAILED'; END IF;
 failed:=false;
 BEGIN
  PERFORM public.create_atomic_expense(desk,1000000::bigint,'USD'::varchar,current_date,'Synthetic'::varchar,'Example'::varchar,'Too large',u,'CASH'::varchar,NULL,NULL,NULL,'schema-smoke-overdraft'::varchar);
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'INSUFFICIENT_FUNDS:%' THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'OVERDRAFT_NOT_BLOCKED'; END IF;
 result:=public.void_income_payment_atomic(pid,u,'Synthetic cancellation');
 IF result->>'success'<>'true' THEN RAISE EXCEPTION 'VOID_FAILED'; END IF;
 IF (SELECT paid_amount_minor FROM public.deal_payment_schedules WHERE id=sch)<>0 THEN RAISE EXCEPTION 'VOID_SCHEDULE_RECALCULATION_FAILED'; END IF;
 IF (SELECT customer_pko_number FROM public.payments WHERE id=pid)<>pko THEN RAISE EXCEPTION 'PKO_NUMBER_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.sms_events) THEN RAISE EXCEPTION 'UNCONFIGURED_SMS_QUEUED'; END IF;
END $smoke$;
ROLLBACK;
SELECT 'passed' AS schema_smoke,
 (SELECT count(*) FROM public.users) AS users_remaining,
 (SELECT count(*) FROM public.payments) AS payments_remaining,
 (SELECT last_number FROM tozon_internal.customer_pko_counter) AS counter_remaining;
`;
