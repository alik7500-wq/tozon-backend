BEGIN;
CREATE OR REPLACE FUNCTION public.construction_post(p_id uuid,p_actor integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE d construction_documents; u users; cfg construction_settings; l jsonb; mid uuid; q numeric; v numeric; qty numeric; val numeric;
 total numeric:=0; e jsonb; acct text; sign integer:=1; receipt construction_documents; amount_value numeric; is_admin boolean;
BEGIN
 SELECT * INTO u FROM users WHERE id=p_actor AND to_jsonb(users)->>'is_active' IN ('true','1');
 IF NOT FOUND THEN RAISE EXCEPTION 'Нет доступа'; END IF;
 is_admin:=u.role='ADMIN' OR coalesce(u.permissions::jsonb,'[]') ? '*';
 SELECT * INTO cfg FROM construction_settings WHERE id=1 FOR UPDATE;
 SELECT * INTO d FROM construction_documents WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Документ не найден'; END IF;
 IF d.status='POSTED' THEN
  IF NOT is_admin AND NOT (coalesce(u.permissions::jsonb,'[]') ? CASE WHEN d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN 'construction.stock' WHEN d.kind LIKE '%ADVANCE%' THEN 'construction.advance' ELSE 'construction.settlements' END) THEN RAISE EXCEPTION 'Недостаточно прав'; END IF;
  RETURN to_jsonb(d);
 END IF;
 IF d.status='CANCELLED' THEN RAISE EXCEPTION 'Документ отменён'; END IF;
 IF d.doc_date<cfg.start_date THEN RAISE EXCEPTION 'Дата раньше начала учёта'; END IF;
 IF d.kind LIKE 'OPENING_%' AND d.doc_date<>cfg.start_date THEN RAISE EXCEPTION 'Начальный остаток должен быть на дату начала учёта'; END IF;
 IF d.kind='ADVANCE_REPORT' THEN
  IF cfg.approver_user_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Авансовый отчёт утверждает назначенный руководитель'; END IF;
  IF d.status<>'SUBMITTED' THEN RAISE EXCEPTION 'Отчёт ещё не отправлен на утверждение'; END IF;
 ELSIF NOT is_admin AND NOT (coalesce(u.permissions::jsonb,'[]') ? CASE WHEN d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN 'construction.stock' WHEN d.kind LIKE '%ADVANCE%' THEN 'construction.advance' ELSE 'construction.settlements' END) THEN
  RAISE EXCEPTION 'Недостаточно прав';
 END IF;
 IF d.kind LIKE 'OPENING_%' AND NOT is_admin THEN RAISE EXCEPTION 'Начальные остатки вводит администратор'; END IF;
 IF NOT is_admin AND d.kind IN ('ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') AND NOT(coalesce(u.permissions::jsonb,'[]') ? 'construction.settlements') THEN RAISE EXCEPTION 'Выдачу и возврат подтверждает финансовый сотрудник'; END IF;
 IF d.party_id IS NOT NULL THEN
  PERFORM id FROM construction_parties WHERE id=d.party_id AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Контрагент неактивен'; END IF;
 END IF;
 IF (d.expense_id IS NOT NULL OR d.payment_id IS NOT NULL) AND d.kind NOT IN ('SETTLEMENT_PAYMENT','ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') THEN RAISE EXCEPTION 'ПКО/РКО связывается только с денежной операцией'; END IF;
 -- Link a previously posted cash document, never create a second cash movement.
 IF d.kind IN ('SETTLEMENT_PAYMENT','ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE') THEN
  IF d.expense_id IS NULL AND d.payment_id IS NULL THEN RAISE EXCEPTION 'Укажите существующий ПКО или РКО'; END IF;
  IF d.kind IN ('ADVANCE_ISSUE','ADVANCE_REIMBURSE') AND d.expense_id IS NULL THEN RAISE EXCEPTION 'Нужен РКО'; END IF;
  IF d.kind='ADVANCE_RETURN' AND d.payment_id IS NULL THEN RAISE EXCEPTION 'Нужен ПКО'; END IF;
  IF d.kind='SETTLEMENT_PAYMENT' AND ((d.balance_type IN ('PAYABLE','ADVANCE_GIVEN') AND d.expense_id IS NULL) OR (d.balance_type IN ('RECEIVABLE','ADVANCE_RECEIVED') AND d.payment_id IS NULL)) THEN RAISE EXCEPTION 'Неверное направление оплаты'; END IF;
  IF d.expense_id IS NOT NULL THEN SELECT to_jsonb(x) INTO e FROM expenses x WHERE id=d.expense_id FOR UPDATE;
  ELSE SELECT to_jsonb(x) INTO e FROM payments x WHERE id=d.payment_id FOR UPDATE; END IF;
  IF e IS NULL OR coalesce(e->>'status','ACTIVE')<>'ACTIVE' OR e->>'voided_at' IS NOT NULL OR e->>'transfer_id' IS NOT NULL OR e->>'conversion_id' IS NOT NULL OR e->>'conversion_expense_id' IS NOT NULL OR coalesce(e->>'operation_type','STANDARD') NOT IN ('STANDARD','EXPENSE','INCOME') THEN RAISE EXCEPTION 'Нужен действующий ПКО/РКО без перемещения или конвертации'; END IF;
  IF e->>'currency'<>d.currency OR (e->>'amount_minor')::numeric<>d.amount*100 THEN RAISE EXCEPTION 'Сумма или валюта не совпадает с кассовым документом'; END IF;
  IF left(coalesce(e->>CASE WHEN d.expense_id IS NULL THEN 'payment_date' ELSE 'expense_date' END,''),10)<>d.doc_date::text THEN RAISE EXCEPTION 'Дата должна совпадать с кассовым документом'; END IF;
 END IF;
 IF d.kind IN ('OPENING_STOCK','RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') THEN
  IF d.warehouse_id IS NULL OR jsonb_array_length(d.lines)=0 THEN RAISE EXCEPTION 'Укажите склад и материалы'; END IF;
  PERFORM id FROM construction_warehouses WHERE id=d.warehouse_id AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Склад неактивен'; END IF;
  IF d.kind='TRANSFER' THEN
   IF d.destination_id IS NULL OR d.destination_id=d.warehouse_id THEN RAISE EXCEPTION 'Укажите другой склад'; END IF;
   PERFORM id FROM construction_warehouses WHERE id=d.destination_id AND active FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Склад назначения неактивен'; END IF;
  END IF;
  IF d.kind IN ('ISSUE','WRITE_OFF') AND (d.project_id IS NULL OR coalesce(trim(d.work_type),'')='') THEN RAISE EXCEPTION 'Укажите объект и вид работ'; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
   mid:=(l->>'material_id')::uuid; q:=(l->>'quantity')::numeric;
   IF q IS NULL OR q<=0 OR q<>round(q,4) THEN RAISE EXCEPTION 'Количество должно быть положительным, до 4 знаков'; END IF;
   PERFORM id FROM construction_materials WHERE id=mid AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Материал не найден или неактивен'; END IF;
   IF EXISTS(SELECT 1 FROM construction_stock_entries s JOIN construction_documents x ON x.id=s.document_id WHERE s.material_id=mid AND s.currency=d.currency AND s.warehouse_id IN (d.warehouse_id,d.destination_id) AND (x.doc_date>d.doc_date OR (d.kind='OPENING_STOCK' AND x.kind<>'OPENING_STOCK'))) THEN RAISE EXCEPTION 'Нельзя провести задним числом: сначала остатки, затем движение по датам'; END IF;
   SELECT coalesce(sum(quantity),0),coalesce(sum(value),0) INTO qty,val FROM construction_stock_entries WHERE warehouse_id=d.warehouse_id AND material_id=mid AND currency=d.currency;
   IF d.kind IN ('ISSUE','TRANSFER','WRITE_OFF') THEN
    IF qty<q THEN RAISE EXCEPTION 'Недостаточно материала на складе в выбранной валюте'; END IF;
    v:=CASE WHEN q=qty THEN val ELSE round(val*q/qty,2) END;
    INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.warehouse_id,mid,d.currency,-q,-v);
    IF d.kind='TRANSFER' THEN INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.destination_id,mid,d.currency,q,v); END IF;
   ELSE
    v:=round((l->>'value')::numeric,2);
    IF v IS NULL OR v<0 THEN RAISE EXCEPTION 'Укажите стоимость материала'; END IF;
    INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) VALUES(d.id,d.warehouse_id,mid,d.currency,q,v);
   END IF;
   total:=total+v;
  END LOOP;
  -- Receipt with supplier creates payable; employee-funded receipt is settled by advance report.
  IF d.kind='RECEIPT' THEN
   IF d.party_id IS NULL THEN RAISE EXCEPTION 'Укажите поставщика или подотчётное лицо'; END IF;
   IF NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') AND total>0 THEN INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,'PAYABLE',total); END IF;
  END IF;
 ELSIF d.kind='ADVANCE_REPORT' THEN
  IF d.party_id IS NULL OR NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') OR jsonb_array_length(d.lines)=0 THEN RAISE EXCEPTION 'Укажите подотчётное лицо и расходы'; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
   IF coalesce(trim(l->>'basis'),'')='' OR coalesce(trim(l->>'proof'),'')='' THEN RAISE EXCEPTION 'Укажите назначение и подтверждающий документ'; END IF;
   IF l->>'receipt_id' IS NOT NULL AND l->>'receipt_id'<>'' THEN
    SELECT * INTO receipt FROM construction_documents WHERE id=(l->>'receipt_id')::uuid;
    IF NOT FOUND OR receipt.status<>'POSTED' OR receipt.kind<>'RECEIPT' OR receipt.party_id<>d.party_id OR receipt.currency<>d.currency OR receipt.doc_date>d.doc_date THEN RAISE EXCEPTION 'Поступление не соответствует подотчётному отчёту'; END IF;
    SELECT sum(value) INTO amount_value FROM construction_stock_entries WHERE document_id=receipt.id;
    IF amount_value<>(l->>'amount')::numeric THEN RAISE EXCEPTION 'Сумма строки не совпадает с поступлением'; END IF;
    INSERT INTO construction_report_receipts(receipt_id,report_id) VALUES(receipt.id,d.id);
   END IF;
   amount_value:=(l->>'amount')::numeric;
   IF amount_value IS NULL OR amount_value<=0 OR amount_value<>round(amount_value,2) THEN RAISE EXCEPTION 'Некорректная сумма расхода'; END IF;
   total:=total+amount_value;
  END LOOP;
  INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,'EMPLOYEE',-total);
 ELSE
  IF d.party_id IS NULL OR d.amount IS NULL THEN RAISE EXCEPTION 'Укажите лицо и сумму'; END IF;
  IF d.kind LIKE '%ADVANCE%' THEN
   IF NOT EXISTS(SELECT 1 FROM construction_parties WHERE id=d.party_id AND kind='EMPLOYEE') THEN RAISE EXCEPTION 'Выберите подотчётное лицо'; END IF;
   acct:='EMPLOYEE'; sign:=CASE WHEN d.kind='ADVANCE_RETURN' THEN -1 ELSE 1 END;
   -- Negative opening balance represents employee overrun owed by company.
   IF d.kind='OPENING_ADVANCE' AND d.balance_type='PAYABLE' THEN sign:=-1; END IF;
  ELSE
   acct:=d.balance_type;
   IF acct IS NULL THEN RAISE EXCEPTION 'Укажите вид задолженности'; END IF;
   sign:=CASE WHEN d.kind='SETTLEMENT_PAYMENT' AND acct IN ('RECEIVABLE','PAYABLE') THEN -1 ELSE 1 END;
  END IF;
  IF d.kind LIKE 'OPENING_%' AND EXISTS(SELECT 1 FROM construction_settlement_entries s JOIN construction_documents x ON x.id=s.document_id WHERE s.party_id=d.party_id AND s.currency=d.currency AND s.account=acct AND x.kind NOT LIKE 'OPENING_%') THEN RAISE EXCEPTION 'Начальный остаток вводится до движения'; END IF;
  INSERT INTO construction_settlement_entries(document_id,party_id,currency,account,amount) VALUES(d.id,d.party_id,d.currency,acct,d.amount*sign);
 END IF;
 UPDATE construction_documents SET status='POSTED',posted_by=p_actor,posted_at=now() WHERE id=d.id RETURNING * INTO d;
 RETURN to_jsonb(d);
END $$;
REVOKE ALL ON FUNCTION public.construction_post(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.construction_post(uuid,integer) TO service_role;
COMMIT;
