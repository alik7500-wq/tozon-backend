-- One live RKO is the source of employee advances, just like supplier settlements.
alter table public.expenses drop constraint expenses_settlement_account_check;
alter table public.expenses add constraint expenses_settlement_account_check
 check(settlement_account in ('PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED','EMPLOYEE'));

-- Preserve existing atomic cash/FX and validation code; extend only the account set.
do $$
declare definition text; signature text; needle text;
begin
 definition:=pg_get_functiondef('public.create_expense_with_settlement(jsonb,integer)'::regprocedure);
 needle:='account not in (''PAYABLE'',''ADVANCE_GIVEN'',''RECEIVABLE'',''ADVANCE_RECEIVED'')';
 if position(needle in definition)=0 then raise exception 'Unexpected settlement RPC version'; end if;
 execute replace(definition,needle,'account not in (''PAYABLE'',''ADVANCE_GIVEN'',''RECEIVABLE'',''ADVANCE_RECEIVED'',''EMPLOYEE'')');
 definition:=pg_get_functiondef('public.construction_validate_expense_settlement()'::regprocedure);
 needle:='kind<>''EMPLOYEE'' and active';
 if position(needle in definition)=0 then raise exception 'Unexpected settlement validation version'; end if;
 definition:=replace(definition,needle,'active and ((kind=''EMPLOYEE'')=(new.settlement_account=''EMPLOYEE''))');
 definition:=replace(definition,'Выберите активного поставщика, подрядчика или дебитора','Выберите активного контрагента: для подотчёта — сотрудника, для остальных расчётов — поставщика, подрядчика или дебитора');
 execute definition;
 -- Reject advances as block costs and as direct supplier payments at the SQL boundary too.
 foreach signature in array array[
 'public.cost_save_allocation(integer,text,integer[],text,integer,integer)',
 'public.cost_save_material_payment(uuid,uuid,integer,numeric,bigint,text,integer,integer)'] loop
  if to_regprocedure(signature) is not null then
   definition:=pg_get_functiondef(to_regprocedure(signature));
   needle:='or exists(select 1 from public.construction_documents where expense_id=p_expense and kind=''ADVANCE_ISSUE'' and status=''POSTED'')';
   if position(needle in definition)=0 then raise exception 'Unexpected cost function version: %',signature; end if;
   execute replace(definition,needle,'or coalesce(to_jsonb(e)->>''settlement_account'','''')=''EMPLOYEE'' '||needle);
  end if;
 end loop;
end $$;
notify pgrst, 'reload schema';
