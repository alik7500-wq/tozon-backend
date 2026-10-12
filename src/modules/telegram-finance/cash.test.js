import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cashCommand,scopeSnapshot,amountMinor,usdDebitMinor,dateChoices} from './cash.js';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const user={telegram_id:'12345',slot:'ILHOM',status:'APPROVED',cash_desk_id:a,crm_user_id:1,can_create_expense:true};
it('scopes cash reports to the exact assigned desk and fails closed without assignment',()=>{
 const data={desks:[{id:a},{id:b}],payments:[{cash_desk_id:a},{cash_desk_id:b},{cash_desk_id:null}],expenses:[{cash_desk_id:a},{cash_desk_id:b}]};
 expect(scopeSnapshot(user,data).payments).toEqual([{cash_desk_id:a}]);expect(scopeSnapshot(user,data).expenses).toEqual([{cash_desk_id:a}]);expect(()=>scopeSnapshot({...user,cash_desk_id:null},data)).toThrow();expect(scopeSnapshot({...user,slot:'AKMALKHON'},data)).toBe(data);
});
it('rejects bad monetary values without floating point input rounding',()=>{expect(amountMinor('1500,50')).toBe(150050);for(const s of ['-1','0','0.001','1e4','21474836.48','abc'])expect(amountMinor(s)).toBeNull();});
it('matches positive numeric database rounding for USD debit previews',()=>{expect(usdDebitMinor(92700,'9.27')).toBe(10000);expect(usdDebitMinor(201,'2')).toBe(101);});
it('denies a forged foreign cash callback before reading the ledger',async()=>{const repo={ledger:vi.fn()},api={send:vi.fn()};await cashCommand({repo,api},user,`book:expense:${b}:0`,true);expect(repo.ledger).not.toHaveBeenCalled();expect(api.send.mock.calls[0][1]).toContain('запрещён');});
it('does not write an expense before confirmation and preserves the draft across steps',async()=>{
 let session=null;const repo={session:async()=>session,saveSession:async(id,s)=>{session=structuredClone(s);},cashDesks:async()=>[{id:a,name:'Own'}],expenseCategories:async()=>[{name:'Строительные материалы'}],draft:vi.fn(async()=>({id:b})),postExpense:vi.fn(async()=>({reference:'РКО-1',amount:100,currency:'USD'})),clearSession:async()=>{session=null;}};const api={send:vi.fn()};const bot={repo,api,clock:()=>new Date('2026-10-12T09:00Z')};
 for(const [c,cb] of [['rnew',true],['rval:USD',true],['rdate:today',true],['rcat:0',true],['100',false],['Synthetic recipient',false],['Synthetic description',false]])await cashCommand(bot,user,c,cb);
 expect(repo.draft).toHaveBeenCalledOnce();expect(repo.postExpense).not.toHaveBeenCalled();expect(session.phase).toBe('confirm');
 await cashCommand(bot,user,`rpost:${b}`,true);expect(repo.postExpense).toHaveBeenCalledWith('12345',b);expect(session).toBeNull();
});
it('validates the additive migration, read-only grants and atomic confirmation on isolated PostgreSQL',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE users(id integer primary key,is_active integer);INSERT INTO users VALUES(1,1);
 CREATE TABLE dictionaries(id uuid primary key,type text,is_active boolean,code text,name text);INSERT INTO dictionaries VALUES('${a}','CASH_DESK',true,'MAIN','Own'),('${b}','CASH_DESK',true,'OTHER','Other');
 CREATE TABLE telegram_finance_subscribers(telegram_id text primary key,slot text,status text);INSERT INTO telegram_finance_subscribers VALUES('12345','ILHOM','APPROVED');
 CREATE TABLE test_expenses(id serial primary key,key text UNIQUE,desk uuid,amount bigint,currency text);
 CREATE FUNCTION public.create_atomic_expense(p_cash_desk_id uuid,p_amount_minor bigint,p_currency varchar,p_expense_date date,p_category varchar,p_recipient varchar,p_description text,p_user_id integer,p_method varchar,p_exchange_rate numeric,p_amount_usd numeric,p_amount_tjs numeric,p_idempotency_key varchar) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE i int;BEGIN
 IF p_amount_minor>100000 THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS';END IF;
 INSERT INTO public.test_expenses(key,desk,amount,currency) VALUES(p_idempotency_key,p_cash_desk_id,p_amount_minor,p_currency) RETURNING id INTO i;
 RETURN jsonb_build_object('expense_id',i,'currency',p_currency,'amount',p_amount_minor/100.0);END;$$;
 GRANT SELECT,UPDATE ON telegram_finance_subscribers TO service_role;GRANT SELECT ON users,dictionaries TO service_role;GRANT ALL ON test_expenses TO service_role;GRANT USAGE,SELECT ON SEQUENCE test_expenses_id_seq TO service_role;
 `);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261012094220_telegram_cash_operations.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261012110000_telegram_crm_user_active_integer.sql',import.meta.url),'utf8'));
 await db.exec(`UPDATE telegram_finance_subscribers SET cash_desk_id='${a}',crm_user_id=1,can_create_expense=true;SET ROLE service_role;`);
 const payload={date:'2026-10-12',amount_minor:92700,currency:'TJS',source_currency:'USD',exchange_rate:9.27,category:'Строительные материалы',recipient:'Synthetic',description:'Synthetic'};
 const make=async(desk,p=payload)=>(await db.query(`INSERT INTO telegram_finance_expense_drafts(telegram_id,cash_desk_id,payload)VALUES('12345',$1,$2)RETURNING id`,[desk,JSON.stringify(p)])).rows[0].id;
 const id=await make(a);const first=(await db.query(`SELECT telegram_finance_post_expense('12345',$1) result`,[id])).rows[0].result;
 expect(first).toMatchObject({amount:100,currency:'USD'});expect((await db.query(`SELECT telegram_finance_post_expense('12345',$1) result`,[id])).rows[0].result).toEqual(first);expect((await db.query('SELECT count(*) n FROM test_expenses')).rows[0].n).toBe(1);
 const foreign=await make(b);await expect(db.query(`SELECT telegram_finance_post_expense('12345',$1)`,[foreign])).rejects.toThrow('CASH_ACCESS_DENIED');
 const large=await make(a,{...payload,currency:'USD',amount_minor:100001});await expect(db.query(`SELECT telegram_finance_post_expense('12345',$1)`,[large])).rejects.toThrow('INSUFFICIENT_FUNDS');expect((await db.query('SELECT status FROM telegram_finance_expense_drafts WHERE id=$1',[large])).rows[0].status).toBe('DRAFT');
 await db.exec("UPDATE telegram_finance_subscribers SET status='REVOKED'");await expect(db.query(`SELECT telegram_finance_post_expense('12345',$1)`,[id])).rejects.toThrow('CASH_ACCESS_DENIED');
 const grants=(await db.query("SELECT has_function_privilege('anon','telegram_finance_post_expense(text,uuid)','EXECUTE') a,has_table_privilege('authenticated','telegram_finance_sessions','SELECT') b")).rows[0];expect(grants).toEqual({a:false,b:false});
 }finally{await db.close();}
});

it('offers today and three earlier dates across month boundaries',()=>{
 const rows=dateChoices('2026-03-01').inline_keyboard;
 expect(rows.map(r=>r[0].callback_data)).toEqual(['rdate:2026-03-01','rdate:2026-02-28','rdate:2026-02-27','rdate:2026-02-26','rdate:manual']);
});
it('shows every CRM expense category after a manually entered date and accepts indices above nine',async()=>{
 let session={phase:'date',desk:a,payload:{currency:'TJS'}};
 const names=Array.from({length:15},(_,i)=>'Статья '+i);
 const repo={session:async()=>session,saveSession:async(id,s)=>{session=structuredClone(s)},expenseCategories:async()=>names.map(name=>({name}))};
 const api={send:vi.fn()};const bot={repo,api,clock:()=>new Date('2026-10-12T09:00Z')};
 await cashCommand(bot,user,'11.10.2026',false);
 expect(session.payload.date).toBe('2026-10-11');expect(api.send.mock.calls[0][2].inline_keyboard).toHaveLength(15);
 await cashCommand(bot,user,'rcat:14',true);
 expect(session.phase).toBe('amount');expect(session.payload.category).toBe('Статья 14');
});
