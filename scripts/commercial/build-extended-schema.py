"""Compile reviewed schema-only catalog snapshots; never connects to a database.
Do not regenerate an already-applied version after changing its input snapshots.
"""
import json, re
from pathlib import Path
root=Path(__file__).resolve().parents[2]
meta=root/'docs/commercial'
prod=json.loads((meta/'production-schema-metadata.json').read_text())
core=json.loads((meta/'test-schema-metadata.json').read_text())
internal=json.loads((meta/'internal-schema-metadata.json').read_text())
funcs=json.loads((meta/'function-definitions-metadata.json').read_text())
def ident(s):
 assert re.fullmatch(r'[a-z_][a-z_0-9]*',s),s
 return '"'+s+'"'
def table(schema,name):
 if '.' in name:
  prefix,name=name.split('.')
  assert prefix==schema
 return ident(schema)+'.'+ident(name)
def column(c,t):
 out=ident(c['name'])+' '+c['type']
 if c['generated']:
  assert c['generated']=='s'
  out+=' GENERATED ALWAYS AS ('+c['default']+') STORED'
 elif c['identity'] or (c['default'] or '').startswith('nextval('):
  out+=' GENERATED '+('ALWAYS' if c['identity']=='a' else 'BY DEFAULT')+' AS IDENTITY'
 elif c['default'] is not None:
  default=c['default']
  if (t,c['name'])==('sms_messages','sender_name'):default=None
  if (t,c['name'])==('construction_settings','start_date'):default=None
  if default is not None:out+=' DEFAULT '+default
 if c['notnull']:out+=' NOT NULL'
 return out
sql=['-- Schema-only reconciliation. No production records, sequence values or grants.','SET LOCAL search_path = public, tozon_internal, pg_catalog;','CREATE SCHEMA tozon_internal;','REVOKE ALL ON SCHEMA tozon_internal FROM PUBLIC, anon, authenticated;','GRANT USAGE ON SCHEMA tozon_internal TO service_role;']
existing={t['name']:t for t in core['tables']}
for schema,data in [('public',prod),('tozon_internal',internal)]:
 for t in data['tables']:
  path=table(schema,t['name']);old=existing.get(t['name']) if schema=='public' else None
  if not old:sql.append('CREATE TABLE '+path+' (\n '+',\n '.join(column(c,t['name']) for c in t['columns'])+'\n);')
  else:
   byname={c['name']:c for c in old['columns']}
   for c in t['columns']:
    if c['name'] not in byname:sql.append('ALTER TABLE '+path+' ADD COLUMN '+column(c,t['name'])+';')
    else:
     prior=byname[c['name']]; col=ident(c['name'])
     assert prior['type']==c['type'],(t['name'],c['name'],'type mismatch')
     if prior['notnull']!=c['notnull']:sql.append('ALTER TABLE '+path+' ALTER COLUMN '+col+(' SET' if c['notnull'] else ' DROP')+' NOT NULL;')
     if prior['default']!=c['default'] and not c['identity'] and not (c['default'] or '').startswith('nextval('):
      sql.append('ALTER TABLE '+path+' ALTER COLUMN '+col+(' SET DEFAULT '+c['default'] if c['default'] is not None else ' DROP DEFAULT')+';')
# All tables first, then keys/checks, finally foreign keys: resolves circular dependencies.
old_constraints={(c['table'],c['name']):c for c in core['constraints']}
for c in core['constraints']:
 if c['kind']=='c' and c['table']!='company_settings' and not any(x['table']==c['table'] and x['name']==c['name'] for x in prod['constraints']):
  # Keep the generic JSON permissions and nonnegative barter checks from the core;
  # remove the fixed role enum, since roles are an extensible dictionary in the app.
  if c['name']=='users_role_check':sql.append('ALTER TABLE public.users DROP CONSTRAINT '+ident(c['name'])+';')
for foreign in [False,True]:
 for schema,data in [('public',prod),('tozon_internal',internal)]:
  for c in data['constraints']:
   if (c['kind']=='f')!=foreign:continue
   key=(c['table'],c['name']);prior=old_constraints.get(key) if schema=='public' else None
   if prior and prior['definition']==c['definition']:continue
   if prior:
    assert c['kind'] in ('c','f'),('cannot replace dependent key',c)
    sql.append('ALTER TABLE '+table(schema,c['table'])+' DROP CONSTRAINT '+ident(c['name'])+';')
   definition=c['definition']
   if schema=='tozon_internal' and c['name']=='customer_pko_counter_last_number_check':definition='CHECK (last_number >= 0)'
   sql.append('ALTER TABLE '+table(schema,c['table'])+' ADD CONSTRAINT '+ident(c['name'])+' '+definition+';')
# Index definitions are schema-qualified catalog output, not business data.
for schema,data in [('public',prod),('tozon_internal',internal)]:
 keys={c['name'] for c in (data['constraints'] or []) if c['kind'] in ('p','u','x')}
 old_indexes={i['name']:i for i in (core['indexes'] or [])} if schema=='public' else {}
 for i in data['indexes']:
  if i['name'] in keys:continue
  prior=old_indexes.get(i['name'])
  if prior and prior['definition']==i['definition']:continue
  if prior:sql.append('DROP INDEX '+table(schema,i['name'])+';')
  sql.append(i['definition']+';')
sql += ["INSERT INTO public.crm_roles(code,name,is_system) VALUES ('ADMIN','Administrator',true),('DIRECTOR','Director',true),('SALES_MANAGER','Sales manager',true),('FINANCE_MANAGER','Finance manager',true),('MANAGER','Manager',true),('WAREHOUSE_MANAGER','Warehouse manager',true);", "INSERT INTO public.crm_document_settings(id,data) VALUES(1,'{}'::jsonb);",'INSERT INTO tozon_internal.customer_pko_counter(id,last_number) VALUES(1,0);']
for schema,data in [('public',prod),('tozon_internal',internal)]:
 for t in data['tables']:
  path=table(schema,t['name'])
  sql += ['ALTER TABLE '+path+' ENABLE ROW LEVEL SECURITY;', 'REVOKE ALL ON '+path+' FROM PUBLIC, anon, authenticated;', 'GRANT SELECT,INSERT,UPDATE,DELETE ON '+path+' TO service_role;']
sql += ['REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, tozon_internal FROM PUBLIC, anon, authenticated;','GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public, tozon_internal TO service_role;']
# View is also protected by underlying-table RLS/grants, with invoker semantics.
sql += ['''CREATE VIEW public.construction_expense_settlements WITH (security_invoker=true) AS
 SELECT id,settlement_party_id AS party_id,settlement_account AS account,currency,expense_date AS doc_date,
 amount_minor::numeric/100::numeric * CASE WHEN settlement_account IN ('PAYABLE','ADVANCE_RECEIVED') THEN -1 ELSE 1 END AS amount,
 reference,description,created_by_user_id,created_at FROM public.expenses
 WHERE settlement_party_id IS NOT NULL AND COALESCE(status,'ACTIVE')='ACTIVE' AND voided_at IS NULL;''',
 'REVOKE ALL ON public.construction_expense_settlements FROM PUBLIC,anon,authenticated;', 'GRANT SELECT ON public.construction_expense_settlements TO service_role;']
function_sql=['-- Backend-only functions. No inherited SECURITY DEFINER privileges or public execution.','SET LOCAL check_function_bodies = off;']
for f in funcs:
 d=f['definition']
 assert not re.search(r'https?://|@[a-z]|[0-9a-f]{8}-[0-9a-f]{4}|net\.|dblink|cron\.',d,re.I),f['name']
 d=d.replace('SECURITY DEFINER','SECURITY INVOKER')
 function_sql.append(d.rstrip()+';')
 sig=table(f['schema'],f['name'])+'('+f['identity']+')'
 function_sql += ['ALTER FUNCTION '+sig+' SECURITY INVOKER;', 'ALTER FUNCTION '+sig+' SET search_path = pg_catalog, public, tozon_internal, pg_temp;', 'REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC, anon, authenticated;', 'GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;']
function_sql += ['SET LOCAL check_function_bodies = on;']
for t in prod['triggers']:
 # All source table names refer to public; function paths explicitly preserved.
 function_sql.append(t['definition']+';')
out='// Generated from reviewed, schema-only catalog snapshots by scripts/commercial/build-extended-schema.py.\n// Immutable once applied. Do not import production records or historical repair migrations.\n'
for name,statements in [('commercialExtendedSchema',sql),('commercialExtendedFunctions',function_sql)]:
 text='\n'.join(statements)+'\n'
 assert '`' not in text and '${' not in text
 out+='export const '+name+' = String.raw`'+text+'`;\n'
(root/'src/db/commercial-extended-schema.js').write_text(out)
print(json.dumps({'schemaStatements':len(sql),'functions':len(funcs),'triggers':len(prod['triggers']),'bytes':len(out)}))
