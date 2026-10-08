-- SMS settings are server-managed; new lifecycle rules default OFF.
ALTER TABLE public.sms_templates ADD COLUMN IF NOT EXISTS customized_at timestamptz;
ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_templates FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sms_templates TO service_role;
CREATE POLICY sms_templates_backend_service ON public.sms_templates TO service_role USING(true) WITH CHECK(true);
CREATE TABLE public.sms_notification_rules (
 event_type text PRIMARY KEY, group_name text NOT NULL, name text NOT NULL,
 template_code text NOT NULL REFERENCES public.sms_templates(code), enabled boolean NOT NULL DEFAULT false,
 mode text NOT NULL DEFAULT 'CONFIRM' CHECK(mode IN ('CONFIRM','INHERIT')),
 offset_days integer NOT NULL DEFAULT 1 CHECK(offset_days BETWEEN 0 AND 30),
 repeat_days integer NOT NULL DEFAULT 7 CHECK(repeat_days BETWEEN 1 AND 90),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), updated_by integer REFERENCES public.users(id),
 CHECK(mode='CONFIRM' OR event_type='PAYMENT_REMINDER')
);
CREATE TABLE public.sms_settings_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, entity text NOT NULL,
 entity_id text NOT NULL, previous jsonb, current jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_settings_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_notification_rules,public.sms_settings_history FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sms_notification_rules,public.sms_settings_history TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.sms_settings_history_id_seq TO service_role;
CREATE POLICY sms_notification_rules_service ON public.sms_notification_rules TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sms_settings_history_service ON public.sms_settings_history TO service_role USING(true) WITH CHECK(true);
INSERT INTO public.sms_templates(code,name,text) VALUES
('RESERVATION_CREATED','При создании брони','Здравствуйте, {{client_name}}! Бронь квартиры №{{apartment}} оформлена. TOZON-PLAZA.'),
('RESERVATION_EXPIRING','До окончания брони','Здравствуйте, {{client_name}}! Срок брони квартиры №{{apartment}} скоро заканчивается. Свяжитесь с отделом продаж. TOZON-PLAZA.'),
('RESERVATION_CANCELLED','При отмене брони','Здравствуйте, {{client_name}}! Бронь квартиры №{{apartment}} отменена. TOZON-PLAZA.'),
('CONTRACT_CREATED','При подписании договора','Здравствуйте, {{client_name}}! Договор №{{contract_number}} оформлен. Квартира №{{apartment}}, стоимость {{contract_total}} {{currency}}. TOZON-PLAZA.'),
('CONTRACT_CHANGED','При изменении квартиры или суммы договора','Здравствуйте, {{client_name}}! Договор №{{contract_number}} изменён: квартира №{{apartment}}, площадь {{apartment_area}} м², стоимость {{contract_total}} {{currency}}. TOZON-PLAZA.'),
('SCHEDULE_CHANGED','При изменении суммы графика выплат','Здравствуйте, {{client_name}}! График выплат по договору №{{contract_number}} изменён. Уточните новый график в отделе продаж. TOZON-PLAZA.'),
('CONTRACT_TERMINATED','При расторжении договора','Здравствуйте, {{client_name}}! Договор №{{contract_number}} расторгнут. TOZON-PLAZA.'),
('CONTRACT_PAID','Полная оплата договора','Здравствуйте, {{client_name}}! Договор №{{contract_number}} полностью оплачен. Спасибо! TOZON-PLAZA.'),
('PAYMENT_CANCELLED','При отмене оплаты','Здравствуйте, {{client_name}}! Платёж по договору №{{contract_number}} отменён. Обратитесь в отдел продаж для уточнения. TOZON-PLAZA.'),
('BIRTHDAY','В день рождения','Уважаемый(ая) {{client_name}}! Поздравляем с днём рождения! Желаем здоровья и благополучия. TOZON-PLAZA.')
ON CONFLICT(code) DO NOTHING;
INSERT INTO public.sms_notification_rules(event_type,group_name,name,template_code,enabled,mode,offset_days,repeat_days) VALUES
('RESERVATION_CREATED','Бронь','При создании брони','RESERVATION_CREATED',false,'CONFIRM',1,7),
('RESERVATION_EXPIRING','Бронь','До окончания брони','RESERVATION_EXPIRING',false,'CONFIRM',1,7),
('RESERVATION_CANCELLED','Бронь','При отмене брони','RESERVATION_CANCELLED',false,'CONFIRM',1,7),
('CONTRACT_CREATED','Договор','При подписании договора','CONTRACT_CREATED',false,'CONFIRM',1,7),
('CONTRACT_CHANGED','Договор','При изменении квартиры или суммы договора','CONTRACT_CHANGED',false,'CONFIRM',1,7),
('SCHEDULE_CHANGED','Договор','При изменении суммы графика выплат','SCHEDULE_CHANGED',false,'CONFIRM',1,7),
('CONTRACT_TERMINATED','Договор','При расторжении договора','CONTRACT_TERMINATED',false,'CONFIRM',1,7),
('PAYMENT_RECEIVED','Платежи','При оплате','PAYMENT_RECEIVED',false,'CONFIRM',1,7),
('CONTRACT_PAID','Договор','При полной оплате договора','CONTRACT_PAID',false,'CONFIRM',1,7),
('PAYMENT_CANCELLED','Платежи','При отмене оплаты','PAYMENT_CANCELLED',false,'CONFIRM',1,7),
('BIRTHDAY','Другой','В день рождения','BIRTHDAY',false,'CONFIRM',1,7),
('PAYMENT_REMINDER','Задолженность','До дня оплаты','PAYMENT_REMINDER',true,'INHERIT',3,7),
('DEBTOR_REMINDER','Задолженность','Сообщение о задолженности','DEBTOR_REMINDER',false,'CONFIRM',1,7);
CREATE SCHEMA IF NOT EXISTS tozon_internal;
REVOKE ALL ON SCHEMA tozon_internal FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION tozon_internal.audit_sms_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.sms_settings_history(entity,entity_id,previous,current)
 VALUES(TG_TABLE_NAME,CASE WHEN TG_TABLE_NAME='sms_notification_rules' THEN to_jsonb(NEW)->>'event_type' ELSE to_jsonb(NEW)->>'id' END,
 CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER sms_rules_audit AFTER UPDATE ON public.sms_notification_rules FOR EACH ROW EXECUTE FUNCTION tozon_internal.audit_sms_settings();
CREATE TRIGGER sms_templates_audit AFTER INSERT OR UPDATE ON public.sms_templates FOR EACH ROW EXECUTE FUNCTION tozon_internal.audit_sms_settings();
CREATE OR REPLACE FUNCTION tozon_internal.queue_configured_sms(p_type text,p_key text,p_client integer,p_deal integer DEFAULT NULL,p_payment integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.sms_notification_rules%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type=p_type AND enabled;
 IF NOT FOUND OR p_client IS NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sms_templates WHERE code=r.template_code AND is_active) THEN RETURN; END IF;
 INSERT INTO public.sms_events(event_type,idempotency_key,mode,client_id,deal_id,payment_id,template_code,payload_json)
 VALUES(p_type,p_key,'CONFIRM',p_client,p_deal,p_payment,r.template_code,jsonb_build_object('managed_rule',true))
 ON CONFLICT(idempotency_key) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION tozon_internal.queue_deal_sms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,tozon_internal AS $$
DECLARE typ text;
BEGIN
 IF TG_OP='INSERT' THEN
  typ:=CASE NEW.status WHEN 'RESERVED' THEN 'RESERVATION_CREATED' WHEN 'SIGNED' THEN 'CONTRACT_CREATED' END;
 ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
  typ:=CASE WHEN NEW.status='SIGNED' THEN 'CONTRACT_CREATED' WHEN NEW.status='CANCELLED' AND OLD.status='RESERVED' THEN 'RESERVATION_CANCELLED' WHEN NEW.status='CANCELLED' THEN 'CONTRACT_TERMINATED' END;
 ELSIF NEW.status='SIGNED' AND (NEW.final_price_minor IS DISTINCT FROM OLD.final_price_minor OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
  typ:='CONTRACT_CHANGED';
 END IF;
 IF typ IS NOT NULL THEN
  PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id||':'||CASE WHEN typ='CONTRACT_CHANGED' THEN txid_current()::text ELSE 'created' END,NEW.lead_id,NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_deal_sms AFTER INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_deal_sms();
CREATE OR REPLACE FUNCTION tozon_internal.queue_payment_sms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,tozon_internal AS $$
DECLARE d public.deals%ROWTYPE; typ text;
BEGIN
 IF NEW.deal_id IS NULL OR COALESCE(NEW.operation_type,'STANDARD') NOT IN ('STANDARD','INCOME','DEAL_PAYMENT') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.status IS DISTINCT FROM 'VOIDED' THEN typ:='PAYMENT_RECEIVED';
 ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status='VOIDED' THEN typ:='PAYMENT_CANCELLED'; END IF;
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id;
 IF typ IS NOT NULL THEN PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id,d.lead_id,d.id,NEW.id); END IF;
 IF typ='PAYMENT_RECEIVED' AND d.status='SIGNED' AND d.final_price_minor>0 AND (SELECT COALESCE(sum(amount_minor),0) FROM public.payments WHERE deal_id=d.id AND status IS DISTINCT FROM 'VOIDED')>=d.final_price_minor THEN
  PERFORM tozon_internal.queue_configured_sms('CONTRACT_PAID','CONTRACT_PAID:'||d.id,d.lead_id,d.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_payment_sms AFTER INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_payment_sms();
CREATE OR REPLACE FUNCTION tozon_internal.queue_schedule_sms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,tozon_internal AS $$
DECLARE d public.deals%ROWTYPE;
BEGIN
 IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.due_date IS DISTINCT FROM OLD.due_date THEN
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id AND status='SIGNED';
 IF FOUND THEN PERFORM tozon_internal.queue_configured_sms('SCHEDULE_CHANGED','SCHEDULE_CHANGED:'||d.id||':'||txid_current(),d.lead_id,d.id); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_schedule_sms AFTER UPDATE ON public.deal_payment_schedules FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_schedule_sms();
CREATE OR REPLACE FUNCTION public.queue_daily_configured_sms(p_date date DEFAULT (now() AT TIME ZONE 'Asia/Dushanbe')::date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,tozon_internal AS $$
DECLARE x record; n integer:=0; r public.sms_notification_rules%ROWTYPE;
BEGIN
 IF abs(p_date-(now() AT TIME ZONE 'Asia/Dushanbe')::date)>1 THEN RAISE EXCEPTION 'INVALID_BUSINESS_DATE'; END IF;
 FOR x IN SELECT id FROM public.leads WHERE archived_at IS NULL AND substring(birth_date,6,5)=to_char(p_date,'MM-DD') LOOP
  PERFORM tozon_internal.queue_configured_sms('BIRTHDAY','BIRTHDAY:'||x.id||':'||extract(year FROM p_date)::text,x.id); n:=n+1;
 END LOOP;
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type='RESERVATION_EXPIRING' AND enabled;
 IF FOUND THEN
 FOR x IN SELECT id,lead_id,reservation_expires_at FROM public.deals WHERE status='RESERVED' AND reservation_expires_at=to_char(p_date+r.offset_days,'YYYY-MM-DD') LOOP
  PERFORM tozon_internal.queue_configured_sms('RESERVATION_EXPIRING','RESERVATION_EXPIRING:'||x.id||':'||x.reservation_expires_at,x.lead_id,x.id); n:=n+1;
 END LOOP;
 END IF;
 SELECT * INTO r FROM public.sms_notification_rules WHERE event_type='DEBTOR_REMINDER' AND enabled;
 IF FOUND THEN
 FOR x IN SELECT DISTINCT d.id,d.lead_id FROM public.deals d JOIN public.deal_payment_schedules s ON s.deal_id=d.id
 WHERE d.status='SIGNED' AND s.due_date<to_char(p_date,'YYYY-MM-DD') AND s.amount_minor>s.paid_amount_minor
 AND NOT EXISTS(SELECT 1 FROM public.sms_events e WHERE e.event_type='DEBTOR_REMINDER' AND e.deal_id=d.id AND e.created_at>=(p_date-r.repeat_days)::timestamptz AND e.status<>'CANCELLED') LOOP
  PERFORM tozon_internal.queue_configured_sms('DEBTOR_REMINDER','DEBTOR_REMINDER:'||x.id||':'||p_date::text,x.lead_id,x.id); n:=n+1;
 END LOOP;
 END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.queue_daily_configured_sms(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.queue_daily_configured_sms(date) TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tozon_internal FROM PUBLIC,anon,authenticated;
